# Findings

Investigations on top of the code from the original video: does the Redis → Postgres pipeline actually survive failures, and where does the time go per request? Every number here comes from a script in `bench/`, so it can be reproduced with one command (see [Reproducing](#reproducing)).

**Environment for the numbers below:** a 2-core cloud VM (Intel Xeon @ 2.30 GHz, 8 GB), Node 22.23, Postgres 16, Redis 7, with the load generator on the same machine. On this machine, single runs varied by up to ±15%, so comparisons use the **median of 3 alternating runs**. Absolute numbers will differ on other hardware; the ratios are the point.

---

## 1. The sync pipeline loses nothing when the worker is killed

`POST /code-fast` and `POST /code-ultra-fast` write only to Redis and enqueue the record; a background worker copies records to Postgres. The claim to test: **a crash at any moment loses no acknowledged write and creates no duplicates.**

**Method** (`npm run chaos`): 30 s of write load on both endpoints while the worker is `SIGKILL`ed at random moments every 0.3–2 s and restarted, so kills land mid-batch, mid-transaction and between the Postgres commit and the Redis trim. The queues are then drained, and every record the API acknowledged with a 201 is looked up in Postgres.

| | Shipped worker | Naive worker (pop, then insert) |
| --- | ---: | ---: |
| Worker kills | 28 | 15 (20 s run) |
| Writes acknowledged | 489,891 | ~293,000 |
| Records lost | **0** | **1,586** |
| Duplicates | **0** | 0 |

**Why it holds:** the worker reads a batch from the oldest end of the queue (`LRANGE`), commits it to Postgres, and only then removes it (`LTRIM`). A crash before the commit rolls back; a crash after it means the batch is inserted again, which the `ON CONFLICT DO NOTHING` inserts ignore. That's at-least-once delivery plus idempotent writes, which adds up to effectively exactly-once. The naive version removes the batch first, so a kill between the two steps loses it, which is exactly what the test caught. (Single-worker design: with several workers, `LMOVE` into a per-worker processing list would be the next step.)

After the load stops, the worker drains its backlog at about **20,000 rows/s** (172,805 rows in 8.5 s) using `unnest()` batch inserts of 500 rows.

### A bug the chaos test found

The first chaos run passed the "no records lost" check but failed "reached Postgres under its Redis id": **76% of `/code-fast` records** (106,469 of 139,742) had been stored under different ids than Redis gave them.

The cause: two independent id allocators feeding one column. `/code-fast` ids come from a Redis counter; synced `/code-ultra-fast` rows took theirs from Postgres' `SERIAL` sequence. Both started at 1,001, so they collided constantly, and the worker's conflict handler quietly renumbered the Redis records. The fix was to give UUID-identified records their own table (`codes_ultra`, keyed by the UUID), since their identity model is different. The chaos test now checks ids, not just counts.

---

## 2. Atomic writes: a Lua script beats MULTI by ~3x

Each fast write touches several keys (uniqueness set, counter, record, queue). The original code made separate calls, so a failure between them left inconsistent data. The fix was to make each write atomic. The interesting part is *how*.

**Method** (`npm run bench:redis`): the Redis write alone, no HTTP, 50 concurrent callers, median of 3 runs.

| Variant | Round trips | Writes/s | Node CPU µs/write | Redis CPU µs/write |
| --- | ---: | ---: | ---: | ---: |
| fast: 3 round trips (original) | 3 | 31,545 | 35.1 | 18.0 |
| **fast: Lua script (shipped)** | 1 | **88,460** | **10.6** | 9.1 |
| ultra: 2 awaits (original) | 2 | 39,251 | 25.6 | 13.5 |
| ultra: MULTI / EXEC | 1 | 27,538 | 42.3 | 12.2 |
| **ultra: Lua script (shipped)** | 1 | **81,504** | **12.1** | 9.4 |

`MULTI` is atomic in one round trip, yet it's the *slowest* option, even slower than the non-atomic original. With ioredis it sends four commands (`MULTI`, `SET`, `LPUSH`, `EXEC`) and parses four replies, each with its own command object and promise: about **3.5x the Node CPU of a single `EVALSHA`**. Redis-side CPU differs far less between the options than Node-side CPU does. The bottleneck is the client.

Over HTTP (`POST /code-ultra-fast`, Cpeak, single process, median of 3):

| | Req/s | p99 |
| --- | ---: | ---: |
| MULTI | 17,060 | 8 ms |
| Lua script | **25,061** | **4 ms** |

**+47% throughput, half the tail latency**, with the same atomicity guarantee. Both keys share a `{shard}` hash tag, so the script stays valid in Redis Cluster.

---

## 3. Where the CPU goes: socket writes and payloads, not frameworks

**Method** (`node bench/profile.js --endpoint "<METHOD> <path>"`): V8 CPU profile of the server under load, with self time grouped by category.

| Endpoint (Cpeak) | Server CPU per request | Biggest cost |
| --- | ---: | --- |
| `GET /simple` | 22 µs | Socket writes (system calls): 76% |
| `POST /code-fast` | 53 µs | Socket writes: ~60% (HTTP response + Redis command) |
| `PATCH /update-something` | 168 µs | Building the response: 34%; `JSON.stringify`: 30% |

On the Redis endpoints, the framework's own code and the app code are each only 1–3% of CPU. These endpoints are bound by system calls: each request costs at least one write to the client socket and one to Redis. Making JavaScript faster barely matters; doing fewer writes is the lever.

### The PATCH endpoint: payload size dominates

`PATCH /update-something` returns a ~33 KB body, and two thirds of its CPU is producing it. Microbenchmark of the pieces (`npm run bench:serialize`):

| Work per request | µs |
| --- | ---: |
| Build the 100-item history as written | 42 |
| Same, computing the timestamp and metadata string once instead of 100 times | 1 |
| `JSON.stringify` the response | 28 |
| fast-json-stringify (Fastify's compiled serializer) | 40 |

Two lessons:

- **Hoisting per-request constants** (100 × `toISOString()` and 100 × `String.repeat()` collapsed to one each) takes the endpoint from 7,037 to **11,790 req/s (+68%)** over HTTP, with p99 dropping from 10 ms to 6 ms (median of 3). The benchmark endpoint keeps its original code, because it deliberately simulates a fixed amount of work identically across the three frameworks, but in real code this is the change the profile points at.
- **"Add a response schema" isn't automatically faster.** For a payload dominated by long strings, V8's native `JSON.stringify` took ~30% less time than fast-json-stringify.

### Bandwidth is the wall at scale

At 11,790 req/s the PATCH endpoint already pushes ~400 MB/s (3.2 Gbit/s) from two cores. At 1M req/s the same payload would be **~33 GB/s, about 266 Gbit/s**, which is why response size, not CPU, became the limit in the original video's cloud tests. Every kilobyte trimmed from a response is worth ~8 Gbit/s at that rate.

---

## 4. What didn't help: Redis auto-pipelining

ioredis's `enableAutoPipelining` batches all commands issued in one event-loop tick into a single socket write. Since socket writes dominate the profile, it looked promising. Median of 3 alternating runs (Cpeak, single process):

| Endpoint | Off | On |
| --- | ---: | ---: |
| `POST /code-fast` | 24,062 | 23,157 |
| `GET /code-fast` | 31,959 | 33,533 |
| `POST /code-ultra-fast` | 23,234 | 23,235 |

All within noise. A likely explanation is that only the Redis half of each request's writes gets batched (the HTTP response still needs its own), and with ~40 requests in flight the batches stay small. It stays available as `REDIS_AUTO_PIPELINING=true` for testing on bigger machines and higher concurrency, but is off by default.

---

## 5. Memory: fingerprints instead of full codes

The Redis uniqueness set held every 500-character code. Storing a 44-character SHA-256 fingerprint instead cut it from **560 to 96 bytes per entry** (measured with 200,000 entries on Redis 7), roughly **11.2 GB → 1.9 GB at 20 million codes**, with collisions still practically impossible.

---

## Reproducing

With Postgres and Redis running (`docker compose up -d`), and no servers running on ports 3000–3002. Commands that take options call `node` directly, because PowerShell strips the `--` in `npm run x -- --option`.

| Command | What it measures | Time |
| --- | --- | --- |
| `npm run chaos` | Section 1: durability under worker crashes | ~1 min |
| `npm run bench:redis` | Section 2: Redis write strategies | ~30 s |
| `node bench/profile.js --endpoint "PATCH /update-something"` | Section 3: CPU profile of any endpoint (saved for DevTools) | ~20 s |
| `npm run bench:serialize` | Section 3: payload build and serialization costs | ~20 s |
| `node bench/run.js --frameworks cpeak --mode single --endpoints code-fast,code-ultra-fast`, with `REDIS_AUTO_PIPELINING` set to `true`, then `false` | Section 4 | ~1 min each |
| `npm run bench` | Full framework × endpoint matrix | ~9 min |

## Next steps

- Run the load generator on a separate machine, so client and server stop competing for CPU.
- Benchmark Redis Cluster mode (`redis.sh`) to see where the single Redis instance stops scaling.
- Support multiple sync workers safely (`LMOVE` to per-worker processing lists, with reclaiming of stale batches).
- Add metrics (queue depth, sync lag, p99 per endpoint), so the pipeline can be watched in production rather than only tested.

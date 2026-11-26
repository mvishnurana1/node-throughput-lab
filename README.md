# Node Throughput Lab

A Node.js API benchmarked across three frameworks (Cpeak, Express and Fastify) on Postgres and Redis, with a crash-safe pipeline that accepts writes in Redis and syncs them to Postgres in the background. It's a test bed for two questions: what actually limits throughput, and what does it take to stay correct while going fast?

What's in it:

- **Three identical APIs**, one per framework, sharing their data-access code so only the framework differs.
- **A write-behind pipeline:** atomic Redis writes (Lua scripts) and a background worker with at-least-once delivery and idempotent inserts into Postgres.
- **Evidence it works:** a chaos test that repeatedly kills the sync worker under load and checks every record, plus 25 integration tests. Both run in CI.
- **Measurement tools:** a framework × endpoint benchmark matrix, a CPU profiler for any endpoint, and focused benchmarks for Redis write strategies and JSON serialization.

**Origin:** this started from the code in Cododev's video [*Let's Handle 1 Million Requests per Second*](https://youtu.be/W4EwfEU8CGA), which reached a million requests per second with a large AWS deployment and a C++ server. This repo focuses on the Node.js side on a single machine. It fixes the bugs listed under [Changes from the original](#changes-from-the-original) and adds the tests, tooling and investigations described in [docs/findings.md](docs/findings.md).

---

### Findings

Highlights from [docs/findings.md](docs/findings.md), where each result comes with the script that reproduces it:

- **No data loss under crashes.** The Redis → Postgres sync worker was `SIGKILL`ed 28 times under ~490k writes with zero records lost or duplicated. A naive pop-then-insert worker lost 1,586 in the same test. The test also caught an id-collision bug that a record count alone would have missed.
- **Lua beats MULTI by ~3x for atomic Redis writes.** With ioredis, `MULTI/EXEC` costs ~3.5x the client CPU of a single Lua call. Switching `/code-ultra-fast` to Lua gave +47% throughput and halved p99 latency.
- **Socket writes and payload size dominate, not frameworks.** CPU profiles show 60–76% of server CPU in socket system calls on the small endpoints. On the 33 KB endpoint, building and serializing the payload is two thirds of the CPU, and hoisting per-request constants gives +68%.
- **What didn't help:** Redis auto-pipelining, and Fastify's compiled serializer (slower than `JSON.stringify` for this payload).

---

### Setup

You need Node.js 20.12 or newer, plus Postgres and Redis. The easiest way to get Postgres and Redis is Docker:

```
docker compose up -d
```

If you run Postgres and Redis yourself instead, that works too.

Copy `.env.example` to `.env` (`cp .env.example .env`, or `Copy-Item .env.example .env` in PowerShell) and adjust it if your setup differs. For Docker, the defaults are already right. Every setting can also be set as an ordinary environment variable, which takes priority over the file.

Install the dependencies:

```
npm install
```

Then create the database and tables, seed them (here with 1 million records), and copy the data into Redis:

```
npm run seed 1000000
npm run migrate
```

> **PowerShell note:** PowerShell strips a `--` before npm sees it, so options like `npm run bench -- --duration 30` never reach the script. Run the script with `node` instead (`node bench/run.js --duration 30`), which works in every shell. That's why the examples below that take options use `node`.

Now you can run the Cpeak, Express, or Fastify version. All three have exactly the same logic; only the framework differs.

```
node cpeak.js      # http://localhost:3000
node express.js    # http://localhost:3001
node fastify.js    # http://localhost:3002
```

You should get a log like this:

```
Cpeak server running at http://localhost:3000
[redis] standalone ready.
[postgres] connected successfully to benchmark.
```

The load-test commands are in [autocannon.txt](autocannon.txt).

**Redis cluster mode**: If you want to run the app with Redis in cluster mode, use the [redis.sh](redis.sh) file to set it up, then set `REDIS_CLUSTER=true`.

---

### Endpoints

| Endpoint | What it does |
| --- | --- |
| `GET /simple` | Returns a tiny JSON response (raw framework overhead) |
| `PATCH /update-something/:id/:name` | Validates input and returns a ~32 KB response |
| `POST /code` | Inserts a random 500-character code into Postgres |
| `GET /code-v1` … `/code-v4` | Four ways to read a random code from Postgres, from a full table scan (v1) to an index lookup (v4) |
| `POST /code-fast` | Writes a code to Redis with a sequential id, queued for syncing to Postgres (standalone Redis only) |
| `POST /code-ultra-fast` | Writes a code to Redis under a UUID, queued for syncing to Postgres (works with Redis Cluster) |
| `GET /code-fast` | Reads a random code from Redis |

---

### Environment Variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PGUSER`, `PGPASSWORD`, `PGHOST`, `PGPORT`, `PGDATABASE` | `postgres`, empty, `localhost`, `5432`, `benchmark` | Postgres connection |
| `PGSSL` | `false` | Set to `true` for hosted databases such as AWS RDS |
| `PG_CONNECT` | `true` | Set to `false` to run without Postgres |
| `REDIS_HOST`, `REDIS_PORT` | `127.0.0.1`, `6379` | Standalone Redis connection |
| `REDIS_CLUSTER` | `false` | Set to `true` to connect to the cluster from `redis.sh` |
| `REDIS_CLUSTER_PORT` | `7000` | Port of any cluster node |

Example:

```
PG_CONNECT=false REDIS_CLUSTER=true node express.js
```

Output should be:

```
Express server running at http://localhost:3001
[redis] cluster ready. Total nodes 30 (masters: 15, replicas: 15)
```

---

### Node.js Cluster Mode

If you want to run the app in cluster mode, you can use PM2 for it. Check first if you have pm2 installed by running `pm2 --version` and if you don't have it, install it by running `npm install -g pm2`.

Then you can start the app in cluster mode by running:

```
pm2 start ecosystem.config.cjs
```

Check the `ecosystem.config.cjs` to change the [environment variables](#environment-variables).

The above command will run the cpeak server by default. If you want it to run Express or Fastify instead, specify the F environment variable like this:

```
F=express pm2 start ecosystem.config.cjs
```

or `F=fastify pm2 start ecosystem.config.cjs` to start the Fastify server.

You can run `pm2 logs` to check the logs of the application when running in cluster mode.

---

### Syncing Redis to Postgres

`POST /code-fast` and `POST /code-ultra-fast` only write to Redis, and queue each new record. A background worker copies the queued records into Postgres in batches, so the database never sees request-rate traffic:

```
npm run sync
```

- Delivery is at-least-once: a batch is removed from its queue only after Postgres has committed it, and re-inserting a row that already exists is a no-op. Run one worker at a time.
- `/code-ultra-fast` records go to their own `codes_ultra` table, keyed by their UUID.
- `/code-fast` ids come from a Redis counter and `POST /code` ids from Postgres, so using both write paths on the same data can hand out the same id twice. The worker detects this, stores the Redis record under a new Postgres id, and logs the mapping.

---

### Benchmarks

To benchmark every endpoint on all three frameworks, both as a single process and in cluster mode (one process per CPU core), with Postgres and Redis running:

```
npm run bench
```

It takes about 9 minutes. It writes a results table, along with your machine's specs, to [bench/results.md](bench/results.md) (raw numbers go to `bench/results.json`). It uses its own `benchmark_bench` database and Redis db 14, so your other data is left alone. Stop any running servers first.

Useful options: `node bench/run.js --duration 30 --frameworks cpeak,fastify --mode cluster`. See the top of [bench/run.js](bench/run.js) for the full list. The individual autocannon commands are still in [autocannon.txt](autocannon.txt) if you'd rather run them by hand.

The load generator runs on the same machine as the server and competes with it for CPU. Treat the numbers as a comparison between frameworks and setups, not as the ceiling of the hardware.

For the deeper investigations (chaos test, CPU profiling, Redis write strategies, serialization), see [Reproducing in docs/findings.md](docs/findings.md#reproducing).

---

### Tests

The integration tests run all three servers against a real Postgres and Redis (start them with `docker compose up -d` first). They use a separate `benchmark_test` database and Redis db 15, so your benchmark data is left alone. Stop any running servers first, since the tests use ports 3000–3002.

```
npm test
```

They also run on every push via GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

---

### Other Commands

When seeding the database, specify the -r option to indicate how many records should be added to the database:

```
npm run seed 20000000
```

_This drops and recreates the `codes` and `codes_ultra` tables, then inserts 20 million records._

To move all the Postgres data over to Redis, run:

```
npm run migrate
```

_This flushes the Redis database first, and does not work with Redis in cluster mode._

---

### Changes from the original

Bugs found and fixed:

- **Sync worker crashed on start.** `database/sync.js` never imported `redis` or `DB`, so it failed with `ReferenceError: redis is not defined`.
- **`/code-ultra-fast` records never reached Postgres.** They were queued on 100 sharded queues that the worker never read. The worker now drains every shard into a `codes_ultra` table keyed by UUID.
- **ID collisions after syncing.** The worker inserted rows with explicit ids, which doesn't advance Postgres' `SERIAL` sequence, so `POST /code` could later be given an id that was already taken. The worker now moves the sequence forward. Any collision that still happens because both write paths were used is stored under a new id and logged, not silently dropped.
- **ID collisions reported as "Code already exists."** `POST /code` returned 409 for any unique violation, including a duplicate primary key. It now returns 409 only for a duplicate code.
- **`/code-fast` wasn't atomic.** It made three separate Redis calls, so a failure between them could leave a code marked as used with no record, or a record that was never queued. It's now a single Lua script: all-or-nothing, and one round trip instead of three.
- **`/code-ultra-fast` wasn't atomic.** It used two separate commands. The record and its queue now share a hash slot, so they're written by one Lua script, even in Redis Cluster. (A `MULTI` version was ~3x slower; see the findings.)
- **Two id allocators collided.** Synced `/code-ultra-fast` rows took ids from the Postgres sequence while `/code-fast` ids came from Redis, so 76% of `/code-fast` records ended up renumbered. Found by the chaos test; UUID records now have their own `codes_ultra` table.
- **Seeding hung forever.** Importing `utils.js` opened a Redis connection that kept the process alive.
- **Seeding inserted the wrong number of rows.** `-r 1000` inserted 10,000, because the last batch was never trimmed.
- **Seeding failed on Windows.** It located the SQL file with `URL.pathname`, which gives `/C:/...` on Windows. It now uses `fileURLToPath`.
- **Time zones disagreed between write paths.** `created_at` was a `TIMESTAMP` with no time zone: rows written by Postgres got the server's local time, while rows synced from Redis got UTC. It's now `TIMESTAMPTZ`.
- **The three servers had drifted apart.** Express and Fastify were missing `/code-ultra-fast` and used a different id range in `/code-v4`. The shared Redis logic now lives in `database/codes.js`.

Improvements:

- The Redis uniqueness set stores a SHA-256 fingerprint of each code instead of the full 500 characters. Measured on Redis 7, that's 560 → 96 bytes per entry, or about 11.2 GB → 1.9 GB at 20 million codes.
- Configuration comes from environment variables / `.env` instead of a hand-written `keys.js`. SSL is now an explicit `PGSSL` setting, so running PM2 locally (which sets `NODE_ENV=production`) no longer tries to use SSL against a local database.
- `docker-compose.yml` for Postgres and Redis, integration tests (`npm test`), and GitHub Actions CI.
- A benchmark runner (`npm run bench`) that tests every endpoint on all three frameworks, single process and clustered, and records the results with the machine's specs.
- Investigation tools: a chaos test for the sync worker (`npm run chaos`), a CPU profiler for any endpoint (`npm run profile`), and focused benchmarks for Redis write strategies and serialization (`npm run bench:redis`, `npm run bench:serialize`). Results are in [docs/findings.md](docs/findings.md).

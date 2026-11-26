/**
 * Integration tests: run against a real Postgres and Redis (see
 * docker-compose.yml). They use a separate database (benchmark_test) and Redis
 * db 15, so they won't touch your benchmark data.
 *
 *   npm test
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Must be set before any project module (and so config.js) is imported.
process.env.PGDATABASE = "benchmark_test";
process.env.REDIS_DB = "15";
process.env.REDIS_CLUSTER = "false";
process.env.PG_CONNECT = "true";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED_COUNT = 2500;

const servers = [
  { name: "cpeak", port: 3000 },
  { name: "express", port: 3001 },
  { name: "fastify", port: 3002 },
];

let pool, redis, syncOnce, createCodeFast;
const children = [];

const runScript = (script, args = []) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 60_000, // the seed script used to hang forever
  });

async function waitForServer(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/simple`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on port ${port} did not start`);
}

const count = async (sql, values) =>
  Number((await pool.query(sql, values)).rows[0].count);

before(async () => {
  const seed = runScript("database/seed.js", ["-r", String(SEED_COUNT)]);
  assert.equal(seed.status, 0, `seed failed or hung:\n${seed.stderr}`);

  const migrate = runScript("database/migrate.js");
  assert.equal(migrate.status, 0, `migrate failed:\n${migrate.stderr}`);

  ({ pool } = await import("../database/index.js"));
  ({ redis } = await import("../database/redis.js"));
  ({ syncOnce } = await import("../database/sync.js"));
  ({ createCodeFast } = await import("../database/codes.js"));

  for (const { name, port } of servers) {
    const alreadyUp = await fetch(`http://localhost:${port}/simple`).then(
      () => true,
      () => false,
    );
    assert.ok(!alreadyUp, `port ${port} is in use; stop running servers first`);

    const child = spawn(process.execPath, [`${name}.js`], {
      cwd: root,
      env: process.env,
      stdio: "ignore",
    });
    children.push(child);
    await waitForServer(port);
  }
});

after(async () => {
  for (const child of children) child.kill();
  await pool?.end();
  redis?.disconnect();
});

describe("seed and migrate", () => {
  it("seeds exactly the number of records asked for", async () => {
    assert.equal(await count("SELECT COUNT(*) FROM codes"), SEED_COUNT);
  });

  it("copies every record to Redis and continues the id sequence", async () => {
    assert.equal(await redis.scard("codes:unique"), SEED_COUNT);
    assert.equal(Number(await redis.get("codes:seq")), SEED_COUNT);
  });
});

for (const { name, port } of servers) {
  const url = (p) => `http://localhost:${port}${p}`;

  describe(`${name} server`, () => {
    it("GET /simple", async () => {
      const res = await fetch(url("/simple"));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { message: "hi" });
    });

    it("PATCH /update-something validates and responds", async () => {
      const bad = await fetch(url("/update-something/abc/john"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(bad.status, 400);

      const ok = await fetch(url("/update-something/7/john?value1=a"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ foo1: "x", foo2: "y" }),
      });
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.equal(body.total_foo, "X. Y. ");
      assert.equal(body.history.length, 100);
    });

    it("POST /code inserts into Postgres", async () => {
      const res = await fetch(url("/code"), { method: "POST" });
      assert.equal(res.status, 201);
      const { created_code } = await res.json();
      assert.equal(
        await count("SELECT COUNT(*) FROM codes WHERE id = $1", [
          created_code.id,
        ]),
        1,
      );
    });

    it("POST /code-fast writes record, fingerprint and queue entry", async () => {
      const queueBefore = await redis.llen("codes:sync_queue");
      const res = await fetch(url("/code-fast"), { method: "POST" });
      assert.equal(res.status, 201);
      const { created_code } = await res.json();

      const stored = await redis.hgetall(`code:${created_code.id}`);
      assert.equal(stored.code, created_code.code);
      assert.equal(await redis.llen("codes:sync_queue"), queueBefore + 1);
    });

    it("POST /code-ultra-fast writes a UUID record", async () => {
      const res = await fetch(url("/code-ultra-fast"), { method: "POST" });
      assert.equal(res.status, 201);
      const { created_code } = await res.json();
      assert.match(created_code.id, /^[0-9a-f-]{36}$/);
      assert.equal(created_code.code.length, 500);
    });

    it("GET /code-fast and /code-v3 return a record", async () => {
      for (const p of ["/code-fast", "/code-v3"]) {
        const res = await fetch(url(p));
        assert.equal(res.status, 200, p);
        assert.ok((await res.json()).data.code, p);
      }
    });
  });
}

describe("createCodeFast (Lua script)", () => {
  it("rejects a duplicate code without touching the id or queue", async () => {
    const code = "d".repeat(500);
    const first = await createCodeFast(code);
    assert.ok(first);

    const seq = await redis.get("codes:seq");
    const queued = await redis.llen("codes:sync_queue");

    assert.equal(await createCodeFast(code), null);
    assert.equal(await redis.get("codes:seq"), seq);
    assert.equal(await redis.llen("codes:sync_queue"), queued);
  });
});

describe("sync worker", () => {
  it("drains every queue into Postgres", async () => {
    // The ID conflicts the servers created above (POST /code and
    // POST /code-fast mixed) are expected here and logged by the worker.
    while ((await syncOnce()) > 0);

    assert.equal(await redis.llen("codes:sync_queue"), 0);
    for (let shard = 0; shard < 100; shard++) {
      assert.equal(await redis.llen(`codes:sync_queue:{${shard}}`), 0);
    }

    // 3 ultra-fast records, in their own table keyed by UUID
    assert.equal(await count("SELECT COUNT(*) FROM codes_ultra"), 3);
  });

  it("loses no records, even when ids conflicted", async () => {
    // seed + 3 x /code + 3 x /code-fast + 1 Lua test
    assert.equal(await count("SELECT COUNT(*) FROM codes"), SEED_COUNT + 7);
  });

  it("is safe to run twice on the same batch", async () => {
    const before = await count("SELECT COUNT(*) FROM codes");
    const id = Number(await redis.get("codes:seq"));
    await redis.lpush("codes:sync_queue", id); // replay an already-synced id
    await syncOnce();
    assert.equal(await count("SELECT COUNT(*) FROM codes"), before);
  });

  it("keeps the Postgres sequence ahead, so POST /code still works", async () => {
    // Used to fail: synced rows took ids the SERIAL sequence had not reached.
    for (const { port } of servers) {
      const res = await fetch(`http://localhost:${port}/code`, {
        method: "POST",
      });
      assert.equal(res.status, 201);
    }
  });
});

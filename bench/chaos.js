/**
 * Chaos test for the Redis -> Postgres sync worker.
 *
 * Puts write load on POST /code-fast and POST /code-ultra-fast while
 * repeatedly SIGKILLing the sync worker at random moments (mid-batch,
 * mid-transaction, between the Postgres commit and the Redis LTRIM), then
 * restarting it. Afterwards it drains the queues and checks that every record
 * the API acknowledged with a 201 reached Postgres exactly once.
 *
 *   docker compose up -d       # or your own Postgres + Redis
 *   npm run chaos
 *
 * Options (run as `node bench/chaos.js --duration 60 ...`, which also works in
 * PowerShell, where `npm run chaos -- ...` loses the options):
 *   --duration <s>   seconds of load            (default 30)
 *   --min-kill <ms>  shortest time between kills (default 300)
 *   --max-kill <ms>  longest time between kills  (default 2000)
 *
 * Uses its own database (benchmark_chaos) and Redis db 13, which it resets.
 * Writes a summary to bench/chaos-results.md.
 */
import autocannon from "autocannon";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { values: opts } = parseArgs({
  options: {
    duration: { type: "string", default: "30" },
    "min-kill": { type: "string", default: "300" },
    "max-kill": { type: "string", default: "2000" },
  },
});

process.env.PGDATABASE = "benchmark_chaos";
process.env.REDIS_DB = "13";
process.env.REDIS_CLUSTER = "false";
process.env.PG_CONNECT = "true";

const SEED = 1000;
const PORT = 3000;
const CONNECTIONS = 10; // per endpoint
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isUp = () =>
  fetch(`http://localhost:${PORT}/simple`).then(
    (r) => r.ok,
    () => false,
  );

function runScript(script, args = []) {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`${script} failed:\n${res.stderr}`);
}

const startWorker = () =>
  spawn(process.execPath, ["database/sync.js"], {
    cwd: root,
    env: process.env,
    stdio: "ignore",
  });

async function main() {
  if (await isUp()) throw new Error(`port ${PORT} is in use; stop servers first`);

  console.log("Resetting benchmark_chaos and Redis db 13...");
  runScript("database/seed.js", ["-r", String(SEED)]);
  runScript("database/migrate.js");

  const server = spawn(process.execPath, ["cpeak.js"], {
    cwd: root,
    env: process.env,
    stdio: "ignore",
  });
  while (!(await isUp())) await sleep(100);

  // Kill the worker at random moments while the load runs.
  let worker = startWorker();
  let kills = 0;
  let loadRunning = true;
  const killer = (async () => {
    const min = Number(opts["min-kill"]);
    const max = Number(opts["max-kill"]);
    while (loadRunning) {
      await sleep(min + Math.random() * (max - min));
      if (!loadRunning) break;
      const exited = new Promise((r) => worker.once("exit", r));
      worker.kill("SIGKILL"); // no chance to finish or clean up
      await exited;
      kills++;
      worker = startWorker();
    }
  })();

  console.log(
    `Load for ${opts.duration}s on both write endpoints, killing the sync worker every ${opts["min-kill"]}-${opts["max-kill"]} ms...`,
  );
  const load = (p) =>
    autocannon({
      url: `http://localhost:${PORT}${p}`,
      method: "POST",
      connections: CONNECTIONS,
      duration: Number(opts.duration),
    });
  const [fast, ultra] = await Promise.all([
    load("/code-fast"),
    load("/code-ultra-fast"),
  ]);
  loadRunning = false;
  await killer;

  // Let the last worker run to completion, timing how fast it drains.
  const { pool } = await import("../database/index.js");
  const { redis } = await import("../database/redis.js");
  const { SYNC_QUEUE, SYNC_SHARDS, shardQueueKey } = await import(
    "../database/codes.js"
  );

  const queued = async () => {
    const p = redis.pipeline().llen(SYNC_QUEUE);
    for (let s = 0; s < SYNC_SHARDS; s++) p.llen(shardQueueKey(s));
    return (await p.exec()).reduce((sum, [, n]) => sum + n, 0);
  };

  const backlog = await queued();
  const drainStart = Date.now();
  while ((await queued()) > 0) await sleep(50);
  const drainSeconds = (Date.now() - drainStart) / 1000;
  worker.kill("SIGTERM");
  await new Promise((r) => worker.once("exit", r));
  server.kill();

  // ----- Verify -----
  const fastAcked = fast["2xx"];
  const ultraAcked = ultra["2xx"];

  const seq = Number(await redis.get("codes:seq"));
  const fastInRedis = seq - SEED;

  const ultraUuids = [];
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "code:{*}:*", "COUNT", 1000);
    cursor = next;
    for (const k of keys) ultraUuids.push(k.slice(k.lastIndexOf(":") + 1));
  } while (cursor !== "0");

  const q = async (sql, values) => Number((await pool.query(sql, values)).rows[0].n);
  const fastInPg = await q(
    "SELECT COUNT(*) AS n FROM codes WHERE id > $1 AND id <= $2",
    [SEED, seq],
  );
  const ultraInPg = await q(
    "SELECT COUNT(*) AS n FROM codes_ultra WHERE id = ANY($1::uuid[])",
    [ultraUuids],
  );
  const codesTotal = await q("SELECT COUNT(*) AS n FROM codes");
  const ultraTotal = await q("SELECT COUNT(*) AS n FROM codes_ultra");

  await pool.end();
  redis.disconnect();

  // autocannon stops counting at the deadline, so requests still in flight
  // then (at most one per connection) are stored but not counted as acked.
  const inFlight = (stored, acked) => stored >= acked && stored - acked <= CONNECTIONS;

  const checks = [
    ["Every acknowledged /code-fast write is in Redis", inFlight(fastInRedis, fastAcked), `${fastAcked} acked, ${fastInRedis} stored (incl. in-flight at the deadline)`],
    ["Every acknowledged /code-ultra-fast write is in Redis", inFlight(ultraUuids.length, ultraAcked), `${ultraAcked} acked, ${ultraUuids.length} stored (incl. in-flight at the deadline)`],
    ["Every /code-fast record reached Postgres under its Redis id", fastInPg === fastInRedis, `${fastInPg} of ${fastInRedis}`],
    ["Every /code-ultra-fast record reached Postgres", ultraInPg === ultraUuids.length, `${ultraInPg} of ${ultraUuids.length}`],
    ["No duplicates in Postgres", codesTotal === SEED + fastInRedis && ultraTotal === ultraUuids.length, `codes: ${codesTotal} rows (expected ${SEED + fastInRedis}), codes_ultra: ${ultraTotal} (expected ${ultraUuids.length})`],
    ["No failed requests", fast.non2xx + fast.errors + ultra.non2xx + ultra.errors === 0, `${fast.non2xx + ultra.non2xx} non-2xx, ${fast.errors + ultra.errors} errors`],
  ];
  const passed = checks.every(([, ok]) => ok);

  const lines = [
    "# Chaos test results",
    "",
    `Generated by \`npm run chaos\` on ${new Date().toISOString().slice(0, 10)} (${os.cpus()[0]?.model.trim()}, ${os.availableParallelism()} cores, Node ${process.version}).`,
    "",
    `- ${opts.duration}s of write load on POST /code-fast and POST /code-ultra-fast (10 connections each)`,
    `- Sync worker SIGKILLed **${kills} times** at random moments (every ${opts["min-kill"]}-${opts["max-kill"]} ms) and restarted`,
    `- ${(fastAcked + ultraAcked).toLocaleString("en-US")} writes acknowledged; ${backlog.toLocaleString("en-US")} were still queued when the load stopped, and the worker drained them in ${drainSeconds.toFixed(1)}s (${Math.round(backlog / Math.max(drainSeconds, 0.001)).toLocaleString("en-US")} rows/s)`,
    "",
    "| Check | Result | Detail |",
    "| --- | --- | --- |",
    ...checks.map(([name, ok, detail]) => `| ${name} | ${ok ? "pass" : "**FAIL**"} | ${detail} |`),
    "",
    `**${passed ? "No records lost or duplicated." : "Some checks failed."}**`,
  ];
  const report = lines.join("\n") + "\n";
  fs.writeFileSync(path.join(root, "bench", "chaos-results.md"), report);
  console.log("\n" + report);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Benchmarks every endpoint on all three frameworks, in a single process and
 * in cluster mode (one process per CPU core), and writes the results with
 * this machine's specs to bench/results.md (plus raw numbers in results.json).
 *
 *   docker compose up -d       # or your own Postgres + Redis
 *   npm run bench
 *
 * Options (run as `node bench/run.js --duration 30 ...`; in PowerShell,
 * `npm run bench -- --duration 30` loses the options because the `--` is stripped):
 *   --duration <s>     seconds per measured run         (default 10)
 *   --warmup <s>       seconds of warm-up before each run (default 2)
 *   --mode <m>         single | cluster | both           (default both)
 *   --frameworks <l>   comma list, e.g. cpeak,fastify    (default all three)
 *   --endpoints <l>    comma list of words to match, e.g. code-fast,simple (default all)
 *   --records <n>      rows to seed before starting      (default 100000)
 *   --connections <n>  autocannon connections            (default 20)
 *   --pipelining <n>   autocannon pipelining             (default 2)
 *   --workers <n>      autocannon worker threads         (default half the cores, max 6)
 *   --out <name>       output file name in bench/        (default results)
 *
 * It uses its own database (benchmark_bench) and Redis db 14, which it resets,
 * so your other data is left alone. The load generator runs on the same
 * machine as the server and competes with it for CPU, so treat the numbers as
 * a comparison between setups rather than a ceiling.
 */
import autocannon from "autocannon";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cores = os.availableParallelism();

const { values: opts } = parseArgs({
  options: {
    duration: { type: "string", default: "10" },
    warmup: { type: "string", default: "2" },
    mode: { type: "string", default: "both" },
    frameworks: { type: "string", default: "cpeak,express,fastify" },
    endpoints: { type: "string", default: "" },
    records: { type: "string", default: "100000" },
    connections: { type: "string", default: "20" },
    pipelining: { type: "string", default: "2" },
    out: { type: "string", default: "results" },
    workers: {
      type: "string",
      default: String(Math.max(1, Math.min(6, Math.floor(cores / 2)))),
    },
  },
});

// Keep benchmark data apart from the user's own database and Redis db.
process.env.PGDATABASE = "benchmark_bench";
process.env.REDIS_DB = "14";
process.env.REDIS_CLUSTER = "false";
process.env.PG_CONNECT = "true";
process.env.NODE_ENV = "production";

const FRAMEWORKS = {
  cpeak: { label: "Cpeak", port: 3000 },
  express: { label: "Express", port: 3001 },
  fastify: { label: "Fastify", port: 3002 },
};

const fooBody = JSON.stringify(
  Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`foo${i + 1}`, "test"]),
  ),
);

const ENDPOINTS = [
  { name: "GET /simple", method: "GET", path: "/simple" },
  {
    name: "PATCH /update-something",
    method: "PATCH",
    path: "/update-something/123/john_doe?value1=abc&value2=xyz",
    body: fooBody,
  },
  { name: "POST /code (Postgres)", method: "POST", path: "/code" },
  { name: "GET /code-v3 (Postgres)", method: "GET", path: "/code-v3" },
  { name: "POST /code-fast (Redis)", method: "POST", path: "/code-fast" },
  { name: "GET /code-fast (Redis)", method: "GET", path: "/code-fast" },
  {
    name: "POST /code-ultra-fast (Redis)",
    method: "POST",
    path: "/code-ultra-fast",
  },
];

const endpointFilter = opts.endpoints.split(",").map((e) => e.trim()).filter(Boolean);
const selectedEndpoints = endpointFilter.length
  ? ENDPOINTS.filter((ep) => endpointFilter.some((w) => ep.name.split(" ")[1] === `/${w}` || ep.name.includes(w)))
  : ENDPOINTS;
if (selectedEndpoints.length === 0) throw new Error(`no endpoints match: ${opts.endpoints}`);

const frameworks = opts.frameworks.split(",").map((f) => f.trim());
for (const f of frameworks) {
  if (!FRAMEWORKS[f]) throw new Error(`unknown framework: ${f}`);
}
const modes = opts.mode === "both" ? ["single", "cluster"] : [opts.mode];
for (const m of modes) {
  if (!["single", "cluster"].includes(m)) throw new Error(`unknown mode: ${m}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isUp = (port) =>
  fetch(`http://localhost:${port}/simple`).then(
    (r) => r.ok,
    () => false,
  );

function runScript(script, args = []) {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`${script} failed:\n${res.stderr || res.stdout}`);
  }
}

async function startServer(framework, mode) {
  const { port } = FRAMEWORKS[framework];
  if (await isUp(port)) {
    throw new Error(`port ${port} is already in use; stop running servers first`);
  }

  const args =
    mode === "cluster" ? ["bench/cluster.js", framework] : [`${framework}.js`];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  for (let i = 0; i < 150; i++) {
    if (await isUp(port)) {
      await sleep(mode === "cluster" ? 1500 : 300); // let every worker connect
      return child;
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  child.kill();
  throw new Error(`${framework} (${mode}) did not start:\n${stderr}`);
}

async function stopServer(child, port) {
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(5000)]);
  while (await isUp(port)) await sleep(100);
}

function load(port, endpoint, duration) {
  return autocannon({
    url: `http://localhost:${port}${endpoint.path}`,
    method: endpoint.method,
    headers: endpoint.body ? { "content-type": "application/json" } : {},
    body: endpoint.body,
    connections: Number(opts.connections),
    pipelining: Number(opts.pipelining),
    workers: Number(opts.workers),
    duration,
  });
}

async function machineInfo() {
  const pkg = await import("pg");
  const config = (await import("../config.js")).default;
  const pool = new pkg.default.Pool(config.pg);
  const pgVersion = (await pool.query("SHOW server_version")).rows[0]
    .server_version;
  await pool.end();

  const { redis } = await import("../database/redis.js");
  const redisVersion = (await redis.info("server")).match(
    /redis_version:(\S+)/,
  )[1];
  redis.disconnect();

  return {
    date: new Date().toISOString().slice(0, 10),
    cpu: os.cpus()[0]?.model.trim() ?? "unknown",
    cores,
    memoryGB: Math.round(os.totalmem() / 1024 ** 3),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    node: process.version,
    postgres: pgVersion,
    redis: redisVersion,
  };
}

const fmt = (n) => Math.round(n).toLocaleString("en-US");

function toMarkdown(machine, results) {
  const lines = [
    "# Benchmark results",
    "",
    `Generated by \`npm run bench\` on ${machine.date}.`,
    "",
    "| Machine | |",
    "| --- | --- |",
    `| CPU | ${machine.cpu} (${machine.cores} logical cores) |`,
    `| Memory | ${machine.memoryGB} GB |`,
    `| OS | ${machine.os} |`,
    `| Node.js | ${machine.node} |`,
    `| Postgres / Redis | ${machine.postgres} / ${machine.redis} |`,
    `| Load | autocannon, ${opts.connections} connections, pipelining ${opts.pipelining}, ${opts.workers} worker thread(s), ${opts.duration}s per run after ${opts.warmup}s warm-up |`,
    `| Redis auto-pipelining | ${process.env.REDIS_AUTO_PIPELINING === "true" ? "on" : "off"} |`,
    "",
    "The load generator runs on the same machine as the server, so the two compete for CPU.",
    "",
  ];

  for (const mode of modes) {
    const rows = results.filter((r) => r.mode === mode);
    const title =
      mode === "single"
        ? "Single process"
        : `Cluster mode (${cores} processes, one per core)`;

    lines.push(`## ${title}: requests per second`, "");
    lines.push(
      `| Endpoint | ${frameworks.map((f) => FRAMEWORKS[f].label).join(" | ")} |`,
      `| --- |${frameworks.map(() => " ---: |").join("")}`,
    );
    for (const ep of selectedEndpoints) {
      const cells = frameworks.map((f) => {
        const r = rows.find((x) => x.framework === f && x.endpoint === ep.name);
        return r ? fmt(r.rps) : "–";
      });
      lines.push(`| ${ep.name} | ${cells.join(" | ")} |`);
    }
    lines.push("");

    lines.push(`<details><summary>${title}: latency and errors</summary>`, "");
    lines.push(
      "| Framework | Endpoint | Req/s | p50 ms | p99 ms | Non-2xx | Errors |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const r of rows) {
      lines.push(
        `| ${FRAMEWORKS[r.framework].label} | ${r.endpoint} | ${fmt(r.rps)} | ${r.p50} | ${r.p99} | ${r.non2xx} | ${r.errors} |`,
      );
    }
    lines.push("", "</details>", "");
  }

  return lines.join("\n");
}

async function main() {
  console.log(`Seeding ${opts.records} records into benchmark_bench...`);
  runScript("database/seed.js", ["-r", opts.records]);
  runScript("database/migrate.js");

  const machine = await machineInfo();
  console.log(
    `${machine.cpu}, ${cores} cores, ${machine.memoryGB} GB, Node ${machine.node}`,
  );

  const results = [];
  for (const mode of modes) {
    for (const framework of frameworks) {
      const { port, label } = FRAMEWORKS[framework];
      const child = await startServer(framework, mode);
      try {
        for (const ep of selectedEndpoints) {
          if (Number(opts.warmup) > 0) await load(port, ep, Number(opts.warmup));
          const r = await load(port, ep, Number(opts.duration));
          const row = {
            mode,
            framework,
            endpoint: ep.name,
            rps: r.requests.average,
            p50: r.latency.p50,
            p99: r.latency.p99,
            non2xx: r.non2xx,
            errors: r.errors + r.timeouts,
          };
          results.push(row);
          console.log(
            `[${mode}] ${label.padEnd(7)} ${ep.name.padEnd(30)} ${fmt(row.rps).padStart(9)} req/s  p99 ${row.p99} ms` +
              (row.non2xx || row.errors
                ? `  (${row.non2xx} non-2xx, ${row.errors} errors)`
                : ""),
          );
        }
      } finally {
        await stopServer(child, port);
      }
    }
  }

  const benchDir = path.join(root, "bench");
  fs.writeFileSync(
    path.join(benchDir, `${opts.out}.json`),
    JSON.stringify({ machine, options: opts, results }, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(benchDir, `${opts.out}.md`),
    toMarkdown(machine, results) + "\n",
  );
  console.log(`\nWrote bench/${opts.out}.md and bench/${opts.out}.json`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

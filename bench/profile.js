/**
 * CPU-profiles one endpoint under load and prints where the time goes:
 * by category (your code, each npm package, Node internals, GC) and the
 * hottest functions by self time.
 *
 *   node bench/profile.js --endpoint "PATCH /update-something"
 *   node bench/profile.js --endpoint "POST /code-ultra-fast" --framework fastify
 *
 * Options: --framework (default cpeak), --seconds (default 10),
 *          --top <n> functions to list (default 12)
 * The raw .cpuprofile is saved in bench/profiles/; open it in Chrome DevTools
 * (Performance tab > Load profile) or VS Code for a flame chart.
 *
 * Uses benchmark_bench / Redis db 14 like `npm run bench`, seeding 10,000 rows.
 */
import autocannon from "autocannon";
import { fork, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values: opts } = parseArgs({
  options: {
    endpoint: { type: "string", default: "GET /simple" },
    framework: { type: "string", default: "cpeak" },
    seconds: { type: "string", default: "10" },
    top: { type: "string", default: "12" },
  },
});

process.env.PGDATABASE = "benchmark_bench";
process.env.REDIS_DB = "14";
process.env.REDIS_CLUSTER = "false";
process.env.NODE_ENV = "production";

const PORTS = { cpeak: 3000, express: 3001, fastify: 3002 };
const port = PORTS[opts.framework];
if (!port) throw new Error(`unknown framework: ${opts.framework}`);

const [method, urlPath] = opts.endpoint.split(" ");
const BODIES = {
  "/update-something": JSON.stringify(
    Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`foo${i + 1}`, "test"])),
  ),
};
const target =
  urlPath === "/update-something"
    ? "/update-something/123/john_doe?value1=abc&value2=xyz"
    : urlPath;
const body = BODIES[urlPath];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isUp = () =>
  fetch(`http://localhost:${port}/simple`).then((r) => r.ok, () => false);

for (const script of [["database/seed.js", "-r", "10000"], ["database/migrate.js"]]) {
  const r = spawnSync(process.execPath, script, { cwd: root, env: process.env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

const profileDir = path.join(root, "bench", "profiles");
fs.mkdirSync(profileDir, { recursive: true });
const before = new Set(fs.readdirSync(profileDir));

if (await isUp()) throw new Error(`port ${port} is in use; stop servers first`);

// A small entry point that exits cleanly on an IPC message, so the profile is
// written (killing with a signal would skip that on Windows).
const server = fork(path.join(root, "bench", "profile-entry.js"), [opts.framework], {
  cwd: root,
  env: process.env,
  execArgv: ["--cpu-prof", `--cpu-prof-dir=${profileDir}`],
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
while (!(await isUp())) await sleep(100);

const load = (duration) =>
  autocannon({
    url: `http://localhost:${port}${target}`,
    method,
    body,
    headers: body ? { "content-type": "application/json" } : {},
    connections: 20,
    pipelining: 2,
    duration,
  });

await load(2); // warm up
const result = await load(Number(opts.seconds));
server.send("stop");
await new Promise((r) => server.once("exit", r));

const file = fs.readdirSync(profileDir).find((f) => !before.has(f) && f.endsWith(".cpuprofile"));
const finalName = `${opts.framework}-${method}-${urlPath.replace(/\W+/g, "_")}.cpuprofile`;
fs.renameSync(path.join(profileDir, file), path.join(profileDir, finalName));
const profile = JSON.parse(fs.readFileSync(path.join(profileDir, finalName), "utf8"));

// ---- Analyse: self time per function, then per category ----
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const selfUs = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  selfUs.set(id, (selfUs.get(id) || 0) + (profile.timeDeltas[i] || 0));
}

const SOCKET_WRITES = new Set(["writev", "writeUtf8String", "writeBuffer", "writeLatin1String", "writeAsciiString", "writeUcs2String"]);

function category(frame) {
  const { url, functionName } = frame;
  if (!url && SOCKET_WRITES.has(functionName)) return "socket writes (system calls)";
  if (functionName === "randomFillSync") return "crypto (random bytes for codes)";
  if (!url) {
    if (functionName === "(idle)") return "idle";
    if (functionName === "(garbage collector)") return "garbage collection";
    if (functionName === "(program)") return "V8 / native";
    return "V8 / native"; // builtins like JSON.stringify, toISOString
  }
  const pkg = url.match(/node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/);
  if (pkg) return `npm: ${pkg[1].replace("\\", "/")}`;
  if (url.startsWith("node:")) return "Node.js internals";
  return "this project";
}

const cats = new Map();
const funcs = new Map();
let total = 0;
for (const [id, us] of selfUs) {
  const { callFrame } = byId.get(id);
  const cat = category(callFrame);
  total += us;
  cats.set(cat, (cats.get(cat) || 0) + us);
  if (cat === "idle") continue;
  const where = callFrame.url
    ? `${path.basename(callFrame.url)}:${callFrame.lineNumber + 1}`
    : "builtin";
  const key = `${callFrame.functionName || "(anonymous)"} (${where})`;
  funcs.set(key, (funcs.get(key) || 0) + us);
}
const busy = total - (cats.get("idle") || 0);
const pct = (us, of) => `${((100 * us) / of).toFixed(1)}%`;

console.log(`\n${opts.framework} ${opts.endpoint}: ${Math.round(result.requests.average).toLocaleString("en-US")} req/s, p99 ${result.latency.p99} ms`);
console.log(`CPU busy ${pct(busy, total)} of the profile; ${(busy / result.requests.total).toFixed(1)} µs of server CPU per request\n`);
console.log("| Where the busy time went | Share |\n| --- | ---: |");
[...cats].filter(([c]) => c !== "idle").sort((a, b) => b[1] - a[1])
  .forEach(([c, us]) => console.log(`| ${c} | ${pct(us, busy)} |`));
console.log(`\n| Hottest functions (self time) | Share |\n| --- | ---: |`);
[...funcs].sort((a, b) => b[1] - a[1]).slice(0, Number(opts.top))
  .forEach(([f, us]) => console.log(`| ${f.replace(/\|/g, "\\|")} | ${pct(us, busy)} |`));
console.log(`\nProfile saved to bench/profiles/${finalName}`);
process.exit(0);

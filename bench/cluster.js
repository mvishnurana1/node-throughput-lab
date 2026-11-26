/**
 * Runs one of the servers on every CPU core with Node's built-in cluster
 * module (the same thing PM2's cluster mode does), without needing PM2.
 *
 *   node bench/cluster.js <cpeak|express|fastify> [workers]
 */
import cluster from "node:cluster";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = process.argv[2];
const workers = Number(process.argv[3]) || os.availableParallelism();

if (!["cpeak", "express", "fastify"].includes(server)) {
  console.error("usage: node bench/cluster.js <cpeak|express|fastify> [workers]");
  process.exit(1);
}

cluster.setupPrimary({ exec: path.join(root, `${server}.js`) });
for (let i = 0; i < workers; i++) cluster.fork();

let stopping = false;
const stop = () => {
  stopping = true;
  for (const worker of Object.values(cluster.workers)) worker.kill();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

cluster.on("exit", () => {
  if (stopping && Object.keys(cluster.workers).length === 0) process.exit(0);
});

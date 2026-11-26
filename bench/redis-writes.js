/**
 * Why is POST /code-ultra-fast (no uniqueness check, no counter) slower than
 * POST /code-fast? This isolates the Redis write from HTTP and compares
 * different ways of issuing it, measuring throughput, Node CPU and Redis CPU
 * per write.
 *
 *   npm run bench:redis
 *
 * Options: --seconds <s> per variant (default 5), --concurrency <n> (default 50)
 * Uses Redis db 12, which it flushes.
 */
import Redis from "ioredis";
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import config from "../config.js";
import { generateCode, codeFingerprint } from "../utils.js";

const { values: opts } = parseArgs({
  options: {
    seconds: { type: "string", default: "5" },
    concurrency: { type: "string", default: "50" },
  },
});

const redis = new Redis({ host: config.redis.host, port: config.redis.port, db: 12 });

redis.defineCommand("fastLua", {
  numberOfKeys: 3,
  lua: `
    if redis.call("SADD", KEYS[1], ARGV[1]) == 0 then return 0 end
    local id = redis.call("INCR", KEYS[2])
    redis.call("HSET", "code:" .. id, "id", id, "code", ARGV[2], "created_at", ARGV[3])
    redis.call("LPUSH", KEYS[3], id)
    return id`,
});
redis.defineCommand("ultraLua", {
  numberOfKeys: 2,
  lua: `
    redis.call("SET", KEYS[1], ARGV[1])
    redis.call("LPUSH", KEYS[2], ARGV[2])
    return 1`,
});

const ultraKeys = () => {
  const id = crypto.randomUUID();
  const shard = parseInt(id.slice(0, 8), 16) % 100;
  const record = JSON.stringify({ id, code: generateCode(), created_at: new Date().toISOString() });
  return { id, record, key: `code:{${shard}}:${id}`, queue: `codes:sync_queue:{${shard}}` };
};

const VARIANTS = {
  "fast: Lua script (shipped)": {
    roundTrips: 1,
    run: () => {
      const code = generateCode();
      return redis.fastLua("codes:unique", "codes:seq", "codes:sync_queue", codeFingerprint(code), code, new Date().toISOString());
    },
  },
  "fast: 3 round trips (original)": {
    roundTrips: 3,
    run: async () => {
      const code = generateCode();
      if ((await redis.sadd("codes:unique", code)) === 0) return;
      const id = await redis.incr("codes:seq");
      await redis
        .pipeline()
        .hset(`code:${id}`, { id, code, created_at: new Date().toISOString() })
        .lpush("codes:sync_queue", id)
        .exec();
    },
  },
  "ultra: 2 awaits (original)": {
    roundTrips: 2,
    run: async () => {
      const { id, record, key, queue } = ultraKeys();
      await redis.set(key, record);
      await redis.lpush(queue, id);
    },
  },
  "ultra: MULTI": {
    roundTrips: 1,
    run: () => {
      const { id, record, key, queue } = ultraKeys();
      return redis.multi().set(key, record).lpush(queue, id).exec();
    },
  },
  "ultra: Lua script": {
    roundTrips: 1,
    run: () => {
      const { id, record, key, queue } = ultraKeys();
      return redis.ultraLua(key, queue, record, id);
    },
  },
};

const redisCpu = async () => {
  const info = await redis.info("cpu");
  const get = (k) => Number(info.match(new RegExp(`${k}:([\\d.]+)`))[1]);
  return get("used_cpu_user") + get("used_cpu_sys");
};

async function measure(run) {
  const deadline = Date.now() + Number(opts.seconds) * 1000;
  let ops = 0;
  const cpu0 = process.cpuUsage();
  const rcpu0 = await redisCpu();
  const t0 = process.hrtime.bigint();

  await Promise.all(
    Array.from({ length: Number(opts.concurrency) }, async () => {
      while (Date.now() < deadline) {
        await run();
        ops++;
      }
    }),
  );

  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  const cpu = process.cpuUsage(cpu0);
  const rcpu = (await redisCpu()) - rcpu0;
  return {
    opsPerSec: ops / seconds,
    nodeUsPerOp: (cpu.user + cpu.system) / ops,
    redisUsPerOp: (rcpu * 1e6) / ops,
  };
}

const fmt = (n) => Math.round(n).toLocaleString("en-US");

await redis.flushdb();
// Warm up the JIT and Redis script cache
for (const v of Object.values(VARIANTS)) for (let i = 0; i < 2000; i++) await v.run();

console.log(`| Variant | Round trips | Writes/s | Node CPU µs/write | Redis CPU µs/write |`);
console.log(`| --- | ---: | ---: | ---: | ---: |`);
for (const [name, v] of Object.entries(VARIANTS)) {
  await redis.flushdb();
  const r = await measure(v.run);
  console.log(`| ${name} | ${v.roundTrips} | ${fmt(r.opsPerSec)} | ${r.nodeUsPerOp.toFixed(1)} | ${r.redisUsPerOp.toFixed(1)} |`);
}

await redis.flushdb();
redis.disconnect();

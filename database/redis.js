import Redis from "ioredis";
import config from "../config.js";

const { host, port, db, cluster, clusterPort, autoPipelining } = config.redis;

const redis = cluster
  ? new Redis.Cluster([{ host, port: clusterPort }], {
      enableAutoPipelining: autoPipelining,
    })
  : new Redis({ host, port, db, enableAutoPipelining: autoPipelining });

/**
 * Creates a /code-fast record in one atomic step.
 *
 * This used to be three round trips (SADD, INCR, then a pipeline with HSET and
 * LPUSH). A crash or a dropped connection between them could leave a code
 * marked as used with no record, or a record that never reached the sync
 * queue. Running it as a Lua script makes it all-or-nothing and cuts it to a
 * single round trip.
 *
 * KEYS: 1 = uniqueness set, 2 = id sequence, 3 = sync queue
 * ARGV: 1 = code fingerprint, 2 = code, 3 = created_at
 * Returns the new id, or 0 if the code already exists.
 *
 * Standalone Redis only: the record key is built inside the script, which
 * Redis Cluster does not allow. /code-ultra-fast is the cluster-friendly path.
 */
redis.defineCommand("createCodeFast", {
  numberOfKeys: 3,
  lua: `
    if redis.call("SADD", KEYS[1], ARGV[1]) == 0 then
      return 0
    end
    local id = redis.call("INCR", KEYS[2])
    redis.call("HSET", "code:" .. id, "id", id, "code", ARGV[2], "created_at", ARGV[3])
    redis.call("LPUSH", KEYS[3], id)
    return id
  `,
});

/**
 * Writes a /code-ultra-fast record and its sync-queue entry atomically.
 *
 * Both keys carry the same {shard} hash tag, so they live in the same slot
 * and this works in Redis Cluster too. A Lua script rather than MULTI/EXEC:
 * with ioredis, MULTI sends four commands and parses four replies, and
 * measured about 4x the Node CPU per write (see bench/redis-writes.js).
 *
 * KEYS: 1 = record key, 2 = shard queue
 * ARGV: 1 = record JSON, 2 = uuid
 */
redis.defineCommand("createCodeUltraFast", {
  numberOfKeys: 2,
  lua: `
    redis.call("SET", KEYS[1], ARGV[1])
    redis.call("LPUSH", KEYS[2], ARGV[2])
    return 1
  `,
});

redis.on("ready", () => {
  if (cluster) {
    console.log(
      `[redis] cluster ready. Total nodes ${redis.nodes().length} (masters: ${redis.nodes("master").length}, replicas: ${redis.nodes("slave").length})`,
    );
  } else {
    console.log("[redis] standalone ready.");
  }
});

redis.on("error", (err) => {
  console.error("Redis Error:", err.message);
});

export { redis };

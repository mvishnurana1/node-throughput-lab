/**
 * Background worker that copies records written to Redis by /code-fast and
 * /code-ultra-fast into Postgres at a controlled pace, so the database is
 * never hit at request rate.
 *
 * Run it with: npm run sync
 *
 * Delivery is at-least-once: a batch is read from the oldest end of a queue
 * and removed only after Postgres has committed it. If the worker dies in
 * between, the batch is simply inserted again next time, and the inserts
 * ignore rows that already exist. Run one worker at a time.
 */
import path from "path";
import { fileURLToPath } from "url";
import config from "../config.js";
import { pool } from "./index.js";
import { redis } from "./redis.js";
import {
  SYNC_QUEUE,
  SYNC_SHARDS,
  shardQueueKey,
  ultraRecordKey,
} from "./codes.js";

const BATCH_SIZE = 500;
const IDLE_DELAY_MS = 200;

// The servers LPUSH, so the oldest entries are at the tail. Oldest first.
async function peekBatch(queue) {
  const ids = await redis.lrange(queue, -BATCH_SIZE, -1);
  return ids.reverse();
}

// Drop the `count` oldest entries (the ones peekBatch returned).
async function removeBatch(queue, count) {
  await redis.ltrim(queue, 0, -count - 1);
}

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** /code-fast records: Redis hashes with ids from the codes:seq counter. */
async function syncFastQueue() {
  const ids = await peekBatch(SYNC_QUEUE);
  if (ids.length === 0) return 0;

  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hgetall(`code:${id}`);
  const results = await pipeline.exec();

  const rows = { id: [], code: [], created_at: [] };
  results.forEach(([err, data], i) => {
    if (err || !data?.code) {
      console.error(`[sync] no Redis data for id ${ids[i]}, skipping it`);
      return;
    }
    rows.id.push(Number(data.id));
    rows.code.push(data.code);
    rows.created_at.push(data.created_at);
  });

  if (rows.id.length > 0) {
    await inTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO codes (id, code, created_at)
         SELECT * FROM unnest($1::int[], $2::text[], $3::timestamptz[])
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [rows.id, rows.code, rows.created_at],
      );

      // Inserting explicit ids does not move the SERIAL sequence. Without
      // this, POST /code would later be handed ids that are already taken.
      const maxId = Math.max(...rows.id);
      await client.query(
        `SELECT setval('codes_id_seq', $1::bigint)
         WHERE $1::bigint > (SELECT last_value FROM codes_id_seq)`,
        [maxId],
      );

      if (inserted.rowCount < rows.id.length) {
        await storeIdConflicts(client, rows);
      }
    });
  }

  await removeBatch(SYNC_QUEUE, ids.length);
  return ids.length;
}

/**
 * Rows skipped by ON CONFLICT are normally ones already synced (a retried
 * batch). If an id is held by a *different* code, Postgres handed that id out
 * itself (POST /code) before Redis did. That happens when both write paths are
 * used on the same data. Rather than drop those records, store them under a
 * new Postgres id and log the mapping.
 */
async function storeIdConflicts(client, rows) {
  const { rows: conflicts } = await client.query(
    `SELECT s.id, s.code, s.created_at::text AS created_at
     FROM unnest($1::int[], $2::text[], $3::timestamptz[]) AS s(id, code, created_at)
     JOIN codes c ON c.id = s.id
     WHERE c.code <> s.code::char(500)`,
    [rows.id, rows.code, rows.created_at],
  );
  if (conflicts.length === 0) return;

  const { rows: stored } = await client.query(
    `INSERT INTO codes (code, created_at)
     SELECT * FROM unnest($1::text[], $2::timestamptz[])
     ON CONFLICT (code) DO NOTHING
     RETURNING id, code`,
    [conflicts.map((r) => r.code), conflicts.map((r) => r.created_at)],
  );

  const newIdByCode = new Map(stored.map((r) => [r.code.trimEnd(), r.id]));
  const mapping = conflicts
    .map((r) => `${r.id}->${newIdByCode.get(r.code.trimEnd()) ?? "already stored"}`)
    .join(", ");

  console.warn(
    `[sync] ${conflicts.length} Redis id(s) were already taken in Postgres ` +
      `(POST /code and POST /code-fast were mixed). Stored under new ids: ` +
      `${mapping}`,
  );
}

/** /code-ultra-fast records: JSON strings keyed by UUID, one queue per shard. */
async function syncUltraShard(shard) {
  const queue = shardQueueKey(shard);
  const ids = await peekBatch(queue);
  if (ids.length === 0) return 0;

  // All keys share the shard's hash tag, so MGET works in cluster mode too.
  const records = await redis.mget(ids.map(ultraRecordKey));

  const rows = { id: [], code: [], created_at: [] };
  records.forEach((json, i) => {
    if (!json) {
      console.error(`[sync] no Redis data for uuid ${ids[i]}, skipping it`);
      return;
    }
    const record = JSON.parse(json);
    rows.id.push(record.id);
    rows.code.push(record.code);
    rows.created_at.push(record.created_at);
  });

  if (rows.id.length > 0) {
    // Their own table, keyed by the UUID. Sharing `codes` meant taking ids
    // from the Postgres sequence, which collided with /code-fast's Redis ids.
    await pool.query(
      `INSERT INTO codes_ultra (id, code, created_at)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::timestamptz[])
       ON CONFLICT (id) DO NOTHING`,
      [rows.id, rows.code, rows.created_at],
    );
  }

  await removeBatch(queue, ids.length);
  return ids.length;
}

/** One pass over every queue. Returns how many queue entries were handled. */
export async function syncOnce() {
  let processed = 0;

  // /code-fast only works with standalone Redis, so its queue only exists there.
  if (!config.redis.cluster) processed += await syncFastQueue();

  for (let shard = 0; shard < SYNC_SHARDS; shard++) {
    processed += await syncUltraShard(shard);
  }

  return processed;
}

async function run() {
  if (!pool) {
    console.error("[sync] needs Postgres; unset PG_CONNECT=false.");
    process.exit(1);
  }

  let stopping = false;
  const stop = () => {
    console.log("[sync] finishing the current batch, then stopping...");
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log("[sync] worker started.");

  while (!stopping) {
    try {
      const processed = await syncOnce();
      if (processed > 0) console.log(`[sync] synced ${processed} records.`);
      else await new Promise((r) => setTimeout(r, IDLE_DELAY_MS));
    } catch (err) {
      // Nothing was removed from the queue, so the batch is retried.
      console.error("[sync] batch failed, retrying shortly:", err.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  await pool.end();
  redis.disconnect();
  console.log("[sync] stopped.");
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) run();

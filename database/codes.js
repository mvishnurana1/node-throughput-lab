/**
 * Redis-backed code storage shared by all three servers (Cpeak, Express and
 * Fastify), so their logic stays identical and only the framework differs.
 */
import crypto from "crypto";
import { redis } from "./redis.js";
import { codeFingerprint } from "../utils.js";

export const UNIQUE_SET = "codes:unique";
export const ID_SEQUENCE = "codes:seq";
export const SYNC_QUEUE = "codes:sync_queue";
export const SYNC_SHARDS = 100;

/**
 * /code-ultra-fast records are spread over SYNC_SHARDS queues. The shard comes
 * from the record's UUID, and both the record key and its queue carry the same
 * `{shard}` hash tag, so in Redis Cluster they live in the same slot. That lets
 * the record and its queue entry be written in one atomic Lua call, even in
 * cluster mode.
 */
export const shardOf = (uuid) => parseInt(uuid.slice(0, 8), 16) % SYNC_SHARDS;
export const shardQueueKey = (shard) => `${SYNC_QUEUE}:{${shard}}`;
export const ultraRecordKey = (uuid) => `code:{${shardOf(uuid)}}:${uuid}`;

/**
 * Stores a code with a sequential id (standalone Redis only).
 * Returns the record, or null if the code already exists.
 */
export async function createCodeFast(code) {
  const created_at = new Date().toISOString();
  const id = await redis.createCodeFast(
    UNIQUE_SET,
    ID_SEQUENCE,
    SYNC_QUEUE,
    codeFingerprint(code),
    code,
    created_at,
  );

  if (id === 0) return null;
  return { id, code, created_at };
}

/**
 * Stores a code under a random UUID, skipping the uniqueness check entirely.
 *
 * We won't bother with id uniqueness here because at a rate of 1 million
 * requests per second, it would take approximately 86,000 years to reach a 50%
 * probability of at least one id duplicate.
 *
 * The math is based on the birthday paradox problem approximation:
 * P(collision) ≈ 1 - e^(-n²/(2N)), with N = 2^122 possible UUIDs.
 * For a 50% chance, n ≈ 2.7×10^18 UUIDs, which at 1 million per second is
 * 2.7×10^12 seconds ≈ 86,000 years.
 */
export async function createCodeUltraFast(code) {
  const id = crypto.randomUUID(); // 122 random bits
  const created_at = new Date().toISOString();
  const record = JSON.stringify({ id, code, created_at });

  // One atomic Lua call (see database/redis.js). It used to be two separate
  // commands, so a failure in between left a record that was never queued
  // and so never reached Postgres.
  await redis.createCodeUltraFast(
    ultraRecordKey(id),
    shardQueueKey(shardOf(id)),
    record,
    id,
  );

  return { id, code, created_at };
}

let cachedMaxId = 0;
let lastCacheUpdate = 0;

/**
 * Highest /code-fast id, cached for 500ms per process to save Redis calls.
 * Only used by the GET /code-fast endpoint.
 */
export async function getMaxId() {
  const now = Date.now();
  if (now - lastCacheUpdate > 500) {
    const maxIdStr = await redis.get(ID_SEQUENCE);
    if (maxIdStr) {
      cachedMaxId = parseInt(maxIdStr, 10);
      lastCacheUpdate = now;
    }
  }
  return cachedMaxId;
}


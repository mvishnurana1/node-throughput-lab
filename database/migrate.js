/*
 Run this script to migrate data from Postgres to Redis in batches.

 Warning: this flushes the selected Redis database first.

 This does not work when Redis is clustered.
*/

import pkg from "pg";
import config, { explainPgError } from "../config.js";
import { codeFingerprint } from "../utils.js";
import { redis } from "./redis.js";
import { UNIQUE_SET, ID_SEQUENCE } from "./codes.js";

if (config.redis.cluster) {
  console.error("migrate.js does not support Redis Cluster.");
  process.exit(1);
}

const pool = new pkg.Pool(config.pg);

const BATCH_SIZE = 2000;

async function migrate() {
  console.log("Starting batch migration...");

  let lastId = 0;
  let totalProcessed = 0;

  // First flush existing Redis data to avoid duplicates
  await redis.flushdb();
  console.log("Flushed existing Redis data.");

  while (true) {
    const { rows } = await pool.query(
      `SELECT id, code, created_at FROM codes
       WHERE id > $1
       ORDER BY id ASC
       LIMIT $2`,
      [lastId, BATCH_SIZE],
    );

    if (rows.length === 0) break; // No more records, we are done!

    const pipeline = redis.pipeline();

    for (const row of rows) {
      pipeline.hset(`code:${row.id}`, {
        id: row.id,
        code: row.code,
        created_at: new Date(row.created_at).toISOString(),
      });

      // For the unique constraint (fingerprint, same as /code-fast uses)
      pipeline.sadd(UNIQUE_SET, codeFingerprint(row.code));

      lastId = row.id;
    }

    await pipeline.exec();

    totalProcessed += rows.length;

    if (totalProcessed % 100000 === 0) {
      console.log(`Processed ${totalProcessed} records...`);
    }
  }

  // Continue the id sequence from Postgres' highest id
  await redis.set(ID_SEQUENCE, lastId);

  console.log(`Migration Finished. Total records: ${totalProcessed}`);
}

migrate()
  .catch((err) => {
    console.error(explainPgError(err) ?? err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    redis.disconnect();
  });

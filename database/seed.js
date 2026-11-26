/*

Run this file like this:
npm run seed

To specify number of records to insert, use -r flag like this:
npm run seed -- -r 20000000

This will insert 20 million records. A bare number works too
(npm run seed 20000000), which matters in PowerShell: it strips the `--`,
so npm swallows `-r` and passes on only the number.

Warning: this drops and recreates the codes and codes_ultra tables.

*/

import pkg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import config, { explainPgError } from "../config.js";
import { generateCode } from "../utils.js";

const { Pool } = pkg;

// fileURLToPath (not URL.pathname) so this also works on Windows, where
// pathname gives "/C:/..." and the SQL file could not be found.
const databaseDir = path.dirname(fileURLToPath(import.meta.url));

const quoteIdent = (name) => `"${name.replace(/"/g, '""')}"`;

// Create the database if it doesn't exist
async function createDatabase() {
  const adminPool = new Pool({ ...config.pg, database: "postgres" });

  const result = await adminPool.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`,
    [config.pg.database],
  );

  if (result.rowCount === 0) {
    await adminPool.query(`CREATE DATABASE ${quoteIdent(config.pg.database)}`);
    console.log(`[postgres] created database: ${config.pg.database}`);
  }

  await adminPool.end();
}

// The number of records to insert: `-r N`, `--records N`, or just `N`.
function recordsToInsert() {
  const args = process.argv.slice(2);
  const flag = args.findIndex((a) => a === "-r" || a === "--records");
  const value = flag !== -1 ? args[flag + 1] : args.find((a) => /^\d+$/.test(a));
  if (value === undefined) return 0;

  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    console.error("The record count must be a whole number, e.g. -r 1000000");
    process.exit(1);
  }
  return n;
}

async function insertSeed(pool, totalRecords) {
  const batchSize = 10000;

  console.log(`\nSeeding the database with ${totalRecords} records...`);

  let inserted = 0;
  for (let offset = 0; offset < totalRecords; offset += batchSize) {
    // The last batch is smaller, so -r 25000 inserts exactly 25,000 rows
    // (it used to round up to a whole batch of 10,000).
    const thisBatch = Math.min(batchSize, totalRecords - offset);
    const codes = Array.from({ length: thisBatch }, generateCode);

    const result = await pool.query(
      `INSERT INTO codes (code)
       SELECT * FROM unnest($1::text[])
       ON CONFLICT (code) DO NOTHING`,
      [codes],
    );
    inserted += result.rowCount;

    console.log(
      `[postgres] inserted records: ${offset + thisBatch}/${totalRecords}`,
    );
  }

  if (inserted !== totalRecords) {
    console.warn(
      `[postgres] ${totalRecords - inserted} duplicate codes were skipped.`,
    );
  }
}

async function main() {
  const totalRecords = recordsToInsert();

  await createDatabase();

  const pool = new Pool(config.pg);

  try {
    console.log(`[postgres] connected to database: ${config.pg.database}`);

    const codesTableSQL = fs.readFileSync(
      path.join(databaseDir, "tables", "codes.sql"),
      "utf8",
    );

    console.log("\nDropping the tables...");
    await pool.query("DROP TABLE IF EXISTS codes, codes_ultra");
    console.log("[postgres] codes and codes_ultra tables were dropped.");

    console.log("\nCreating the tables...");
    await pool.query(codesTableSQL);
    console.log("[postgres] tables were created successfully.");

    if (totalRecords === 0) {
      console.log("No records to insert for seeding. Exiting.");
    } else {
      await insertSeed(pool, totalRecords);
      console.log("\nDatabase seeding completed.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(explainPgError(err) ?? err);
  process.exit(1);
});

/**
 * All runtime settings, read from environment variables.
 *
 * If a `.env` file exists in the directory you run the app from, it is loaded
 * first (see `.env.example`). Variables already set in your shell win over the
 * file. Every setting has a default that works with a fresh local Postgres and
 * Redis, or with `docker compose up`.
 */
import fs from "node:fs";

if (fs.existsSync(".env")) {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(); // Node >= 20.12
  } else {
    console.warn(
      `[config] Found .env, but Node ${process.version} can't read it. ` +
        "Upgrade to Node 20.12 or newer, or set the variables in your shell.",
    );
  }
}

const env = process.env;

const config = {
  pg: {
    user: env.PGUSER || "postgres",
    password: env.PGPASSWORD || "",
    host: env.PGHOST || "localhost",
    port: Number(env.PGPORT || 5432),
    database: env.PGDATABASE || "benchmark",
    // Turn on for hosted databases such as AWS RDS.
    ssl: env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
  },

  // Set PG_CONNECT=false to run the servers without Postgres.
  pgConnect: env.PG_CONNECT !== "false",

  redis: {
    host: env.REDIS_HOST || "127.0.0.1",
    port: Number(env.REDIS_PORT || 6379),
    db: Number(env.REDIS_DB || 0), // standalone only; Redis Cluster has a single db
    cluster: env.REDIS_CLUSTER === "true",
    clusterPort: Number(env.REDIS_CLUSTER_PORT || 7000),
    // Batch every command issued in the same event-loop tick into one socket
    // write. See docs/findings.md for the measurements.
    autoPipelining: env.REDIS_AUTO_PIPELINING === "true",
  },
};

/**
 * Turns common Postgres connection errors into a message that says what to do.
 * Returns null for anything it doesn't recognise.
 */
export function explainPgError(err) {
  const { host, port, user, database } = config.pg;
  const message = String(err?.message || "");

  if (message.includes("client password must be a string")) {
    return (
      "Postgres needs a password, but none is set. Copy .env.example to .env " +
      '(with docker compose the password is "postgres"), or set PGPASSWORD.'
    );
  }
  if (err?.code === "28P01") {
    return `Postgres rejected user "${user}". Check PGUSER and PGPASSWORD in .env.`;
  }
  if (err?.code === "ECONNREFUSED") {
    return (
      `Can't reach Postgres at ${host}:${port}. Is it running? ` +
      "With Docker: start Docker Desktop, then run `docker compose up -d`."
    );
  }
  if (err?.code === "3D000") {
    return `Database "${database}" doesn't exist yet. Run \`npm run seed\` first.`;
  }
  return null;
}

export default config;

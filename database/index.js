import pkg from "pg";
import config, { explainPgError } from "../config.js";

// Set PG_CONNECT=false to skip the connection (useful for testing without a DB)
const shouldConnect = config.pgConnect;

export const pool = shouldConnect ? new pkg.Pool(config.pg) : null;

if (shouldConnect) {
  pool.query("SELECT NOW()", (err) => {
    if (err) {
      console.error("[postgres] connection failed.");
      const hint = explainPgError(err);
      if (hint) console.error(hint);
      else console.error("Error details:\n", err);
      process.exit(1);
    } else {
      console.log(
        "[postgres] connected successfully to " + config.pg.database + ".",
      );
    }
  });
}

// For any general query
const query = async (text, values) => {
  if (!shouldConnect) {
    console.warn("[postgres] Query attempted but DB connection is disabled.");
    return [];
  }

  const res = await pool.query(text, values);
  return res.rows;
};

export const DB = {
  query,
};

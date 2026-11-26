import cpeak, { parseJSON } from "cpeak";
import crypto from "crypto";
import { DB } from "./database/index.js";
import { redis } from "./database/redis.js";
import { generateCode } from "./utils.js";
import {
  createCodeFast,
  createCodeUltraFast,
  getMaxId,
} from "./database/codes.js";

const app = cpeak();

process.title = "node-cpeak";

app.beforeEach(parseJSON({ limit: 1024 * 1024 }));

app.route("get", `/simple`, (req, res) => {
  res.json({ message: "hi" });
});

app.route("patch", `/update-something/:id/:name`, (req, res) => {
  const { id, name } = req.params;
  const { value1, value2 } = req.query;

  // Validate id and name
  if (isNaN(Number(id))) {
    return res.status(400).json({ error: "id must be a number" });
  } else if (!name || name.length < 3) {
    return res
      .status(400)
      .json({ error: "name is required and must be at least 3 characters" });
  }

  const formattedFooValues = [];

  for (let i = 1; i <= 10; i++) {
    const val = req.body[`foo${i}`];
    const formattedVal = typeof val === "string" ? `${val}. ` : val;
    formattedFooValues.push(formattedVal);
  }

  // Adding all the formatted foo values together
  const totalFoo = formattedFooValues.join("");

  // Generating a few kilobytes of dummy data
  const dummyHistory = Array.from({ length: 100 }).map((_, i) => ({
    event_id: Number(id) + i,
    timestamp: new Date().toISOString(),
    action: `Action performed by ${name}`,
    metadata:
      "This is a string intended to take up space to simulate a medium-sized production API response object.".repeat(
        2,
      ),
    status: i % 2 === 0 ? "success" : "pending",
  }));

  res.json({
    id,
    name,
    value1,
    value2,
    total_foo: String(totalFoo).toUpperCase(),
    history: dummyHistory,
  });
});

// Inserts a simple record to the database
app.route("post", "/code", async (req, res) => {
  const code = generateCode();

  // Create a new code record
  try {
    const result = await DB.query(
      `
      INSERT INTO codes (code)
      VALUES ($1)
      RETURNING id, code, created_at
    `,
      [code],
    );

    res.status(201).json({ created_code: result[0] });
  } catch (err) {
    if (err.code === "23505" && err.constraint === "codes_code_key") {
      // Unique violation on the code column. Other unique violations (such as
      // the id) are server-side problems and must not be reported as a 409.
      return res.status(409).json({ error: "Code already exists." });
    }

    throw err;
  }
});

// Reads a simple random code from the database and returns it
app.route("get", "/code-v1", async (req, res) => {
  // This is Big O(n) - Full Table Scan
  const result = await DB.query(
    `
      SELECT id, code, created_at
      FROM codes
      ORDER BY RANDOM()
      LIMIT 1
    `,
  );

  if (result.length === 0) {
    return res.status(404).json({ error: "No codes found." });
  }

  res.json({ data: result[0] });
});

app.route("get", "/code-v2", async (req, res) => {
  const countResult = await DB.query(`SELECT COUNT(*) FROM codes`);
  const count = parseInt(countResult[0].count, 10);

  if (count === 0) return res.status(404).json({ error: "No codes found." });

  // Generate a random ID between 1 and Count
  const randomId = crypto.randomInt(1, count + 1);

  // Fetch the record by ID (Index Lookup)
  const result = await DB.query(
    `
      SELECT id, code, created_at
      FROM codes
      WHERE id = $1
    `,
    [randomId],
  );

  if (result.length === 0) {
    return res.status(404).json({ error: "record not found" });
  }

  res.json({ data: result[0] });
});

app.route("get", "/code-v3", async (req, res) => {
  const maxResult = await DB.query(
    `SELECT id FROM codes ORDER BY id DESC LIMIT 1`,
  );

  if (maxResult.length === 0)
    return res.status(404).json({ error: "No codes found." });

  const maxId = maxResult[0].id;

  // Generate random ID up to Max
  const randomId = crypto.randomInt(1, maxId + 1);

  // Fetch (Index Lookup)
  const result = await DB.query(
    `SELECT id, code, created_at FROM codes WHERE id = $1`,
    [randomId],
  );

  if (result.length === 0) {
    return res.status(404).json({ error: "record not found" });
  }

  res.json({ data: result[0] });
});

app.route("get", "/code-v4", async (req, res) => {
  const randomId = crypto.randomInt(1, 10_000_000 + 1); // kinda like cheating

  // Fetch the record by ID (Index Lookup). This is Big O(1)
  const result = await DB.query(
    `
      SELECT id, code, created_at
      FROM codes
      WHERE id = $1
    `,
    [randomId],
  );

  if (result.length === 0) {
    return res.status(404).json({ error: "record not found" });
  }

  res.json({ data: result[0] });
});

// Inserts a simple record to the database through Redis for super fast O(1) operations
app.route("post", "/code-fast", async (req, res) => {
  const code = generateCode();

  // Uniqueness check, id, record and sync-queue entry in one atomic
  // Redis call (a Lua script, see database/redis.js). O(1).
  const record = await createCodeFast(code);

  if (!record) {
    return res.status(409).json({ error: "Code already exists." });
  }

  const { id, created_at } = record;

  res.status(201).json({
    created_code: { id, code, created_at },
  });
});

app.route("post", "/code-ultra-fast", async (req, res) => {
  // UUID ids, no uniqueness check (see database/codes.js for why that's safe)
  const record = await createCodeUltraFast(generateCode());

  res.status(201).json({ created_code: record });
});

// Gets a code but through Redis for super fast O(1) lookups
app.route("get", "/code-fast", async (req, res) => {
  // Get max ID
  const maxId = await getMaxId();
  if (maxId === 0) return res.status(404).json({ error: "No codes found." });

  // Generating a random ID
  const randomId = crypto.randomInt(1, maxId + 1);

  // Fetch the code (O(1) Hash Lookup)
  const result = await redis.hgetall(`code:${randomId}`);

  if (Object.keys(result).length === 0) {
    return res.status(404).json({ error: "record not found" });
  }

  res.json({ data: result });
});

app.handleErr((error, req, res) => {
  console.error(error);
  res.status(500).json({
    error: "Sorry, something unexpected happened on our side.",
  });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Cpeak server running at http://localhost:${PORT}`);
});

/**
 * The PATCH /update-something profile shows two thirds of its CPU going to
 * building and serializing its ~32 KB response. This measures the options in
 * isolation (no HTTP):
 *
 *  - building the payload as the endpoint does vs. hoisting the per-request
 *    constants (one timestamp and one metadata string instead of 100 each)
 *  - JSON.stringify vs. fast-json-stringify, the compiled serializer Fastify
 *    uses when a route declares a response schema
 *
 *   npm run bench:serialize
 */
import fastJson from "fast-json-stringify";

const id = "123";
const name = "john_doe";

const buildAsIs = () =>
  Array.from({ length: 100 }).map((_, i) => ({
    event_id: Number(id) + i,
    timestamp: new Date().toISOString(),
    action: `Action performed by ${name}`,
    metadata:
      "This is a string intended to take up space to simulate a medium-sized production API response object.".repeat(2),
    status: i % 2 === 0 ? "success" : "pending",
  }));

const METADATA =
  "This is a string intended to take up space to simulate a medium-sized production API response object.".repeat(2);
const buildHoisted = () => {
  const timestamp = new Date().toISOString();
  const action = `Action performed by ${name}`;
  const history = new Array(100);
  for (let i = 0; i < 100; i++) {
    history[i] = {
      event_id: Number(id) + i,
      timestamp,
      action,
      metadata: METADATA,
      status: i % 2 === 0 ? "success" : "pending",
    };
  }
  return history;
};

const wrap = (history) => ({
  id,
  name,
  value1: "abc",
  value2: "xyz",
  total_foo: "TEST. TEST. TEST. TEST. TEST. TEST. TEST. TEST. TEST. TEST. ",
  history,
});

const stringifyCompiled = fastJson({
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    value1: { type: "string" },
    value2: { type: "string" },
    total_foo: { type: "string" },
    history: {
      type: "array",
      items: {
        type: "object",
        properties: {
          event_id: { type: "integer" },
          timestamp: { type: "string" },
          action: { type: "string" },
          metadata: { type: "string" },
          status: { type: "string" },
        },
      },
    },
  },
});

// Same output either way
if (stringifyCompiled(wrap(buildHoisted())) !== JSON.stringify(wrap(buildHoisted()))) {
  // timestamps can differ by a millisecond; compare lengths instead
  if (stringifyCompiled(wrap(buildHoisted())).length !== JSON.stringify(wrap(buildHoisted())).length)
    throw new Error("serializers disagree");
}

function measure(fn, ms = 3000) {
  for (let i = 0; i < 2000; i++) fn(); // warm up
  let n = 0;
  const end = performance.now() + ms;
  let sink = 0;
  while (performance.now() < end) {
    for (let i = 0; i < 100; i++) sink += fn().length;
    n += 100;
  }
  if (sink === 0) console.log(""); // keep the work from being optimised away
  return (ms * 1000) / n; // µs per call
}

const rows = [
  ["Build as-is + JSON.stringify (current endpoint)", () => JSON.stringify(wrap(buildAsIs()))],
  ["Build as-is only", () => buildAsIs()],
  ["Build hoisted only", () => buildHoisted()],
  ["JSON.stringify only", ((p) => () => JSON.stringify(p))(wrap(buildHoisted()))],
  ["fast-json-stringify only", ((p) => () => stringifyCompiled(p))(wrap(buildHoisted()))],
  ["Build hoisted + fast-json-stringify", () => stringifyCompiled(wrap(buildHoisted()))],
];

console.log(`Response size: ${JSON.stringify(wrap(buildAsIs())).length.toLocaleString("en-US")} bytes\n`);
console.log("| Work per request | µs |\n| --- | ---: |");
for (const [label, fn] of rows) console.log(`| ${label} | ${measure(fn).toFixed(1)} |`);

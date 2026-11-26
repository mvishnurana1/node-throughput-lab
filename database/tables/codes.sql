create table if not exists codes (
  id SERIAL PRIMARY KEY,
  code CHAR(500) UNIQUE NOT NULL,
  -- TIMESTAMPTZ so rows written by Postgres (now()) and rows synced from Redis
  -- (UTC ISO strings) agree, whatever time zone the server runs in.
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Records from /code-ultra-fast, which are identified by a UUID generated in
-- the app rather than a sequential id. They get their own table: putting them
-- in `codes` meant taking ids from the Postgres sequence, which collided with
-- the ids Redis hands out for /code-fast (found by bench/chaos.js).
create table if not exists codes_ultra (
  id UUID PRIMARY KEY,
  code CHAR(500) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

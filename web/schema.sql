-- D1 schema for the builder-signer daily limits (server/limits.ts).
-- Apply with: npx wrangler d1 execute yaynay-limits --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS hits (k TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;

-- Web Push price alerts (server/pushStore.ts, push-worker/). Only the push subscription and the
-- alert targets are stored: no wallet address, no IP. Same DDL is created on first use.
CREATE TABLE IF NOT EXISTS push_subs (
  id TEXT PRIMARY KEY,          -- hash of the endpoint
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created INTEGER NOT NULL,     -- ms since epoch
  seen INTEGER NOT NULL,        -- last sync from the browser
  last_ok INTEGER               -- last successful delivery
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS push_alerts (
  sub_id TEXT NOT NULL,
  id TEXT NOT NULL,             -- the client's alert id
  token_id TEXT NOT NULL,
  op TEXT NOT NULL,             -- 'above' | 'below'
  price REAL NOT NULL,          -- 0-1
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created INTEGER NOT NULL,
  fired_at INTEGER,
  fired_price REAL,
  misses INTEGER NOT NULL DEFAULT 0, -- checker runs in a row with no CLOB midpoint for the token
  PRIMARY KEY (sub_id, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS push_alerts_armed ON push_alerts (fired_at, token_id, misses);
-- Cached totals ('subs', 'armed') recounted by the checker, so a sync never scans whole tables.
CREATE TABLE IF NOT EXISTS push_meta (k TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;

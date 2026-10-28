CREATE TABLE events (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  stage TEXT NOT NULL,
  reset_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  post_url TEXT NOT NULL,
  author TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  text TEXT NOT NULL,
  eta TEXT,
  confidence TEXT NOT NULL,
  confirmations TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX events_product_created ON events (product, created_at DESC);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret TEXT NOT NULL,
  secret_prev TEXT,
  secret_prev_until INTEGER,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX subscriptions_status ON subscriptions (status);
CREATE INDEX subscriptions_ip ON subscriptions (ip_hash, created_at);

CREATE TABLE deliveries (
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  http_status INTEGER,
  ok INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX deliveries_sub ON deliveries (subscription_id, at DESC);

CREATE TABLE kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

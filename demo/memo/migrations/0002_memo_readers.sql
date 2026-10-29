CREATE TABLE memo_readers (
  email TEXT PRIMARY KEY NOT NULL,
  first_opened_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL,
  visits INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX memo_readers_latest ON memo_readers (last_opened_at DESC);
CREATE TABLE memo_limits (
  key TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX memo_limits_expiry ON memo_limits (expires_at);

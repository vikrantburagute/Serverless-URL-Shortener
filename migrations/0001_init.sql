CREATE TABLE links (
  code TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  -- SHA-256 of the private stats key given to the creator. NULL = admin-only stats.
  stats_key_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_links_created_at ON links (created_at);

-- One row per redirect. No IP addresses are stored.
CREATE TABLE clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL REFERENCES links (code) ON DELETE CASCADE,
  clicked_at TEXT NOT NULL DEFAULT (datetime('now')),
  country TEXT,
  referrer TEXT,
  device TEXT,
  browser TEXT
);

CREATE INDEX idx_clicks_code_time ON clicks (code, clicked_at);

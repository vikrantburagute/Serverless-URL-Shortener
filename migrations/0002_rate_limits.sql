-- Fixed-window request counters. `key` is "<bucket>:<window>:<sha256 of IP>", so raw IPs are never stored.
-- Old windows are cleared by the hourly cron trigger.
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
) WITHOUT ROWID;

CREATE INDEX idx_rate_limits_window ON rate_limits (window_start);

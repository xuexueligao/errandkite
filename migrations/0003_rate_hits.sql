-- Rate limiting for the public answer endpoint. One row per accepted answer
-- and limited key. The key is a SHA-256 hash (of the client IP, or the payout
-- address), never the raw IP. Rows older than a day are deleted by the cron job.
CREATE TABLE rate_hits (
  bucket     TEXT NOT NULL,             -- which limit, e.g. answer_ip
  key        TEXT NOT NULL,             -- SHA-256 hex of the limited value
  created_at INTEGER NOT NULL           -- unix seconds
);

CREATE INDEX rate_hits_lookup ON rate_hits (bucket, key, created_at);
CREATE INDEX rate_hits_created ON rate_hits (created_at);

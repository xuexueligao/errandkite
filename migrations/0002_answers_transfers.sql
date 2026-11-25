-- Answers from humans, and the one on-chain transfer each bounty ends with:
-- a payout to the accepted answer (accepting -> paid) or a refund to the payer
-- (refunding -> refunded).
--
-- The transfer is signed locally and its hash and raw bytes are stored BEFORE
-- it is broadcast. A retry re-sends the same signed transaction, so a crash or
-- a timeout can never make the platform pay twice.
ALTER TABLE bounties ADD COLUMN accepted_answer_id TEXT;
ALTER TABLE bounties ADD COLUMN transfer_to TEXT;          -- payout or refund recipient
ALTER TABLE bounties ADD COLUMN transfer_tx TEXT;          -- hash of the signed transfer
ALTER TABLE bounties ADD COLUMN transfer_raw TEXT;         -- signed transaction, cleared once confirmed
ALTER TABLE bounties ADD COLUMN transfer_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bounties ADD COLUMN transfer_error TEXT;

CREATE INDEX bounties_status_expires ON bounties (status, expires_at);

CREATE TABLE answers (
  id              TEXT PRIMARY KEY,
  bounty_id       TEXT NOT NULL REFERENCES bounties (id),
  body            TEXT NOT NULL,
  payout_address  TEXT NOT NULL,              -- checksummed, so the unique key ignores case
  created_at      INTEGER NOT NULL,
  UNIQUE (bounty_id, payout_address)
);

CREATE INDEX answers_bounty_created ON answers (bounty_id, created_at);

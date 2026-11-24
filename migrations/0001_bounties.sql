-- Bounties posted by agents. A row is created as pending_payment before the
-- x402 payment settles, and becomes open only after settlement succeeds.
CREATE TABLE bounties (
  id               TEXT PRIMARY KEY,
  status           TEXT NOT NULL CHECK (status IN (
                     'pending_payment', 'void', 'open', 'answered',
                     'accepting', 'paid', 'refunding', 'refunded')),
  question         TEXT NOT NULL,
  reward_usd       TEXT NOT NULL,           -- decimal string as posted, e.g. "0.10"
  reward_units     TEXT NOT NULL,           -- token base units (pieUSD has 18 decimals)
  network          TEXT NOT NULL,           -- CAIP-2, e.g. eip155:2368
  asset            TEXT NOT NULL,           -- token contract address
  source           TEXT NOT NULL CHECK (source IN ('agent', 'manual')),
  manage_token_hash TEXT NOT NULL,          -- SHA-256 hex; the token itself is never stored
  payer            TEXT,                    -- set from the settlement response
  payment_tx       TEXT,                    -- settlement transaction hash
  created_at       INTEGER NOT NULL,        -- unix seconds
  expires_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX bounties_status_created ON bounties (status, created_at DESC);

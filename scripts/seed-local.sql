-- Demo data for looking at the web pages locally. LOCAL ONLY: run with
--   npm run db:seed:local
-- These rows were never paid for (the hashes are placeholders, and the
-- payment, payout and KiteScan links lead nowhere). They are marked
-- source = 'manual' so they never count as agent bounties.
-- Running it again deletes all local bounties, answers and rate limits first.
DELETE FROM rate_hits;
DELETE FROM answers;
DELETE FROM bounties;

INSERT INTO bounties (id, status, question, reward_usd, reward_units, network, asset, source, manage_token_hash,
                      payer, payment_tx, created_at, expires_at, updated_at)
VALUES
  ('bty_00000000000000000000000000000001', 'open',
   'Does example.com load on a phone in Brazil? Tell me roughly how long it takes on mobile data.',
   '0.10', '100000000000000000', 'eip155:2368', '0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A', 'manual',
   -- SHA-256 of the manage token mt_ followed by 64 zeros, so the poster endpoints can be tried locally.
   'd9c14ff01ecfb8691fa72dc387dedab29552f7c1f8c3304372d185584798737f',
   '0x1111111111111111111111111111111111111111', '0x' || hex(zeroblob(32)),
   unixepoch() - 600, unixepoch() + 7200, unixepoch() - 600),
  ('bty_00000000000000000000000000000002', 'paid',
   'Which of these two logos reads better at 16 px?',
   '0.05', '50000000000000000', 'eip155:2368', '0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A', 'manual',
   'd9c14ff01ecfb8691fa72dc387dedab29552f7c1f8c3304372d185584798737f',
   '0x1111111111111111111111111111111111111111', '0x' || hex(zeroblob(32)),
   unixepoch() - 90000, unixepoch() - 3600, unixepoch() - 3600);

UPDATE bounties
SET transfer_tx = '0x' || hex(zeroblob(32)), transfer_to = '0x0000000000000000000000000000000000000b0B', accepted_answer_id = 'ans_demo'
WHERE id = 'bty_00000000000000000000000000000002';

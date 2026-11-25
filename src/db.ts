export type BountyStatus =
  | "pending_payment"
  | "void"
  | "open"
  | "answered"
  | "accepting"
  | "paid"
  | "refunding"
  | "refunded";

export interface BountyRow {
  id: string;
  status: BountyStatus;
  question: string;
  reward_usd: string;
  reward_units: string;
  network: string;
  asset: string;
  source: "agent" | "manual";
  manage_token_hash: string;
  payer: string | null;
  payment_tx: string | null;
  created_at: number;
  expires_at: number;
  updated_at: number;
  accepted_answer_id: string | null;
  transfer_to: string | null;
  transfer_tx: string | null;
  transfer_raw: string | null;
  transfer_attempts: number;
  transfer_error: string | null;
}

export interface AnswerRow {
  id: string;
  bounty_id: string;
  body: string;
  payout_address: string;
  created_at: number;
}

/** Statuses that are visible to the public. pending_payment and void are never listed. */
export const PUBLIC_STATUSES: readonly BountyStatus[] = ["open", "answered", "accepting", "paid", "refunding", "refunded"];

export async function insertPendingBounty(db: D1Database, row: Pick<BountyRow, "id" | "question" | "reward_usd" | "reward_units" | "network" | "asset" | "source" | "manage_token_hash" | "created_at" | "expires_at" | "updated_at">): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bounties (id, status, question, reward_usd, reward_units, network, asset, source,
         manage_token_hash, created_at, expires_at, updated_at)
       VALUES (?, 'pending_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.question,
      row.reward_usd,
      row.reward_units,
      row.network,
      row.asset,
      row.source,
      row.manage_token_hash,
      row.created_at,
      row.expires_at,
      row.updated_at,
    )
    .run();
}

/**
 * Moves a bounty from pending_payment to open after its payment settled.
 * Conditional on the current status, so it can only happen once.
 */
export async function activateBounty(db: D1Database, id: string, payer: string | null, paymentTx: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE bounties SET status = 'open', payer = ?, payment_tx = ?, updated_at = ?
       WHERE id = ? AND status = 'pending_payment'`,
    )
    .bind(payer, paymentTx, now, id)
    .run();
  return result.meta.changes === 1;
}

/** Marks a bounty void when its payment did not settle. */
export async function voidBounty(db: D1Database, id: string, now: number): Promise<void> {
  await db
    .prepare(`UPDATE bounties SET status = 'void', updated_at = ? WHERE id = ? AND status = 'pending_payment'`)
    .bind(now, id)
    .run();
}

export async function getBounty(db: D1Database, id: string): Promise<BountyRow | null> {
  return db.prepare(`SELECT * FROM bounties WHERE id = ?`).bind(id).first<BountyRow>();
}

export type BountyWithCount = BountyRow & { answer_count: number };

export async function getBountyWithCount(db: D1Database, id: string): Promise<BountyWithCount | null> {
  return db
    .prepare(`SELECT b.*, (SELECT COUNT(*) FROM answers a WHERE a.bounty_id = b.id) AS answer_count FROM bounties b WHERE b.id = ?`)
    .bind(id)
    .first<BountyWithCount>();
}

export async function listPublicBounties(
  db: D1Database,
  options: { status?: BountyStatus; limit: number; before?: number },
): Promise<BountyWithCount[]> {
  const statuses = options.status ? [options.status] : [...PUBLIC_STATUSES];
  const placeholders = statuses.map(() => "?").join(", ");
  const before = options.before ?? Number.MAX_SAFE_INTEGER;
  const { results } = await db
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM answers a WHERE a.bounty_id = b.id) AS answer_count
       FROM bounties b WHERE b.status IN (${placeholders}) AND b.created_at < ?
       ORDER BY b.created_at DESC, b.id DESC LIMIT ?`,
    )
    .bind(...statuses, before, options.limit)
    .all<BountyWithCount>();
  return results;
}

export const MAX_ANSWERS_PER_BOUNTY = 50;

export type InsertAnswerResult = "ok" | "duplicate" | "too_many" | "closed";

/**
 * Adds an answer and moves the bounty from open to answered. The insert only
 * happens while the bounty is open or answered and has not expired, checked in
 * the same statement, so an answer can never land on a closed bounty.
 */
export async function insertAnswer(db: D1Database, row: AnswerRow): Promise<InsertAnswerResult> {
  const count = await db.prepare(`SELECT COUNT(*) AS n FROM answers WHERE bounty_id = ?`).bind(row.bounty_id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ANSWERS_PER_BOUNTY) return "too_many";
  try {
    const [inserted] = await db.batch([
      db
        .prepare(
          `INSERT INTO answers (id, bounty_id, body, payout_address, created_at)
           SELECT ?, id, ?, ?, ? FROM bounties
           WHERE id = ? AND status IN ('open', 'answered') AND expires_at > ?`,
        )
        .bind(row.id, row.body, row.payout_address, row.created_at, row.bounty_id, row.created_at),
      db
        .prepare(`UPDATE bounties SET status = 'answered', updated_at = ? WHERE id = ? AND status = 'open' AND expires_at > ?`)
        .bind(row.created_at, row.bounty_id, row.created_at),
    ]);
    return inserted.meta.changes === 1 ? "ok" : "closed";
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) return "duplicate";
    throw err;
  }
}

export async function listAnswers(db: D1Database, bountyId: string): Promise<AnswerRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM answers WHERE bounty_id = ? ORDER BY created_at ASC, id ASC`)
    .bind(bountyId)
    .all<AnswerRow>();
  return results;
}

export async function getAnswer(db: D1Database, bountyId: string, answerId: string): Promise<AnswerRow | null> {
  return db.prepare(`SELECT * FROM answers WHERE id = ? AND bounty_id = ?`).bind(answerId, bountyId).first<AnswerRow>();
}

/** answered -> accepting. Only one caller can win, and only before the bounty expires. */
export async function markAccepting(db: D1Database, bountyId: string, answer: AnswerRow, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE bounties SET status = 'accepting', accepted_answer_id = ?, transfer_to = ?, updated_at = ?
       WHERE id = ? AND status = 'answered' AND expires_at > ?`,
    )
    .bind(answer.id, answer.payout_address, now, bountyId, now)
    .run();
  return result.meta.changes === 1;
}

/** open (no answers yet) -> refunding, when the poster cancels. */
export async function markCancelled(db: D1Database, bountyId: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE bounties SET status = 'refunding', transfer_to = payer, updated_at = ?
       WHERE id = ? AND status = 'open' AND payer IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM answers WHERE bounty_id = bounties.id)`,
    )
    .bind(now, bountyId)
    .run();
  return result.meta.changes === 1;
}

/** open or answered past expires_at -> refunding. Returns how many bounties expired. */
export async function expireBounties(db: D1Database, now: number): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE bounties SET status = 'refunding', transfer_to = payer, updated_at = ?
       WHERE status IN ('open', 'answered') AND expires_at <= ? AND payer IS NOT NULL`,
    )
    .bind(now, now)
    .run();
  return result.meta.changes;
}

/** Bounties whose payout or refund has not been confirmed yet, oldest first. */
export async function listPendingTransfers(db: D1Database, limit: number): Promise<BountyRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM bounties WHERE status IN ('accepting', 'refunding') ORDER BY updated_at ASC, id ASC LIMIT ?`)
    .bind(limit)
    .all<BountyRow>();
  return results;
}

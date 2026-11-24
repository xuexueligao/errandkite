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
}

/** Statuses that are visible to the public. pending_payment and void are never listed. */
export const PUBLIC_STATUSES: readonly BountyStatus[] = ["open", "answered", "accepting", "paid", "refunding", "refunded"];

export async function insertPendingBounty(db: D1Database, row: Omit<BountyRow, "status" | "payer" | "payment_tx">): Promise<void> {
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

export async function listPublicBounties(
  db: D1Database,
  options: { status?: BountyStatus; limit: number; before?: number },
): Promise<BountyRow[]> {
  const statuses = options.status ? [options.status] : [...PUBLIC_STATUSES];
  const placeholders = statuses.map(() => "?").join(", ");
  const before = options.before ?? Number.MAX_SAFE_INTEGER;
  const { results } = await db
    .prepare(
      `SELECT * FROM bounties WHERE status IN (${placeholders}) AND created_at < ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .bind(...statuses, before, options.limit)
    .all<BountyRow>();
  return results;
}

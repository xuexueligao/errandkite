import type { BountyStatus } from "./db.js";

/** Statuses whose reward is still in the platform wallet. */
const HELD: readonly BountyStatus[] = ["open", "answered", "accepting", "refunding"];

/**
 * The escrow books, from the database. All amounts are pieUSD base units.
 * Every bounty in these statuses was paid for, so by construction
 * held = received - paidOut - refunded. What can actually go wrong is the
 * wallet holding less than `held`; checkEscrow compares the two.
 */
export interface EscrowLedger {
  received: bigint;
  paidOut: bigint;
  refunded: bigint;
  held: bigint;
  /** Part of `held` whose payout or refund is signed and may already be mined. */
  inFlight: bigint;
}

export async function escrowLedger(db: D1Database): Promise<EscrowLedger> {
  // Summed here with bigint: 18-decimal amounts overflow SQLite integers after ~9 pieUSD.
  const { results } = await db
    .prepare(
      `SELECT status, reward_units, transfer_tx FROM bounties
       WHERE status IN ('open', 'answered', 'accepting', 'paid', 'refunding', 'refunded')`,
    )
    .all<{ status: BountyStatus; reward_units: string; transfer_tx: string | null }>();
  const ledger: EscrowLedger = { received: 0n, paidOut: 0n, refunded: 0n, held: 0n, inFlight: 0n };
  for (const row of results) {
    const units = BigInt(row.reward_units);
    ledger.received += units;
    if (row.status === "paid") ledger.paidOut += units;
    else if (row.status === "refunded") ledger.refunded += units;
    if (HELD.includes(row.status)) {
      ledger.held += units;
      if (row.transfer_tx) ledger.inFlight += units;
    }
  }
  return ledger;
}

/**
 * - ok: the wallet holds at least everything owed
 * - settling: short only by transfers that are signed and may already be mined
 *   but not yet recorded; the cron job will catch up
 * - short: money is missing; needs an operator
 * - unknown: the wallet balance could not be read
 */
export type EscrowStatus = "ok" | "settling" | "short" | "unknown";

export function checkEscrow(ledger: EscrowLedger, walletUnits: bigint | null): EscrowStatus {
  if (walletUnits === null) return "unknown";
  if (walletUnits >= ledger.held) return "ok";
  if (walletUnits >= ledger.held - ledger.inFlight) return "settling";
  return "short";
}

/** Below this much native KITE the wallet may not afford gas for payouts and refunds. */
export const LOW_GAS_WEI = 10n ** 16n; // 0.01 KITE

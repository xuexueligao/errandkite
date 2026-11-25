import type { BountyRow } from "./db.js";

export type Hex = `0x${string}`;
export type TxStatus = "success" | "reverted" | "pending" | "not_found";

/**
 * Sends pieUSD from the platform wallet. The production version is in
 * chain.ts; tests use a fake. Signing and sending are separate steps so the
 * signed transaction can be stored before it is broadcast.
 */
export interface TokenTransfers {
  /** Signs an ERC-20 transfer with the next free nonce. Does not broadcast. */
  sign(to: Hex, amount: bigint): Promise<{ hash: Hex; raw: Hex }>;
  /**
   * Broadcasts a signed transaction. "nonce_used" means the nonce was already
   * taken, so this exact transaction can never be mined. Other errors throw.
   */
  broadcast(raw: Hex): Promise<"sent" | "nonce_used">;
  status(hash: Hex): Promise<TxStatus>;
  /** Waits up to timeoutMs for a receipt, then reports the status. */
  waitFor(hash: Hex, timeoutMs: number): Promise<TxStatus>;
}

/** After this many signed transactions that did not succeed, stop and leave it to the operator. */
export const MAX_TRANSFER_ATTEMPTS = 5;

export type TransferOutcome = "confirmed" | "pending" | "failed" | "skipped";

const KIND = {
  accepting: { done: "paid", label: "payout" },
  refunding: { done: "refunded", label: "refund" },
} as const;

async function recordError(db: D1Database, id: string, message: string, now: number) {
  await db.prepare(`UPDATE bounties SET transfer_error = ?, updated_at = ? WHERE id = ?`).bind(message.slice(0, 500), now, id).run();
}

/**
 * Moves one bounty's payout or refund forward by one step and reports where it
 * stands. Safe to call again at any time, from a request or from the cron job:
 *
 * - No signed transaction yet: sign, store hash and raw bytes, then broadcast.
 *   Only the caller that stores first broadcasts.
 * - Signed but not seen on chain: re-broadcast the same bytes. Same nonce,
 *   same transaction, so it can be mined at most once.
 * - The nonce was taken by another transaction and ours is not on chain: ours
 *   can never be mined, so it is safe to sign a new one.
 * - Reverted: counts as a failed attempt; a new one is signed until
 *   MAX_TRANSFER_ATTEMPTS is reached.
 */
export async function advanceTransfer(
  db: D1Database,
  transfers: TokenTransfers | null,
  bounty: BountyRow,
  now: number,
  waitMs = 0,
): Promise<TransferOutcome> {
  if (bounty.status !== "accepting" && bounty.status !== "refunding") return "skipped";
  const kind = KIND[bounty.status];
  if (!transfers) {
    await recordError(db, bounty.id, "payouts are not configured (PLATFORM_PRIVATE_KEY is missing)", now);
    return "failed";
  }
  if (!bounty.transfer_to) {
    await recordError(db, bounty.id, `no ${kind.label} recipient`, now);
    return "failed";
  }

  const finalize = async (hash: string) => {
    await db
      .prepare(
        `UPDATE bounties SET status = ?, transfer_raw = NULL, transfer_error = NULL, updated_at = ?
         WHERE id = ? AND status = ? AND transfer_tx = ?`,
      )
      .bind(kind.done, now, bounty.id, bounty.status, hash)
      .run();
    console.log(JSON.stringify({ event: `${kind.label}_confirmed`, bounty_id: bounty.id, tx: hash }));
    return "confirmed" as const;
  };

  // Drops a transaction that can never be mined, so a new one can be signed.
  const discard = async (hash: string, reason: string) => {
    await db
      .prepare(`UPDATE bounties SET transfer_tx = NULL, transfer_raw = NULL, transfer_error = ?, updated_at = ? WHERE id = ? AND transfer_tx = ?`)
      .bind(reason, now, bounty.id, hash)
      .run();
  };

  if (bounty.transfer_tx) {
    const hash = bounty.transfer_tx as Hex;
    const status = await transfers.status(hash);
    if (status === "success") return finalize(hash);
    if (status === "pending") return "pending";
    if (status === "reverted") {
      await discard(hash, `${kind.label} transaction ${hash} reverted`);
    } else {
      // not_found: send the same signed bytes again.
      try {
        const sent = bounty.transfer_raw ? await transfers.broadcast(bounty.transfer_raw as Hex) : "nonce_used";
        if (sent === "sent") return settleAfterSend(hash);
        // The nonce is used. If ours is still not on chain, it never will be.
        const again = await transfers.status(hash);
        if (again === "success") return finalize(hash);
        if (again === "pending") return "pending";
        await discard(hash, `${kind.label} transaction ${hash} was replaced (nonce used)`);
      } catch (err) {
        await recordError(db, bounty.id, `broadcast failed: ${(err as Error).message}`, now);
        return "pending";
      }
    }
  }

  // Sign a new transaction.
  const fresh = await db.prepare(`SELECT transfer_tx, transfer_attempts FROM bounties WHERE id = ?`).bind(bounty.id).first<{ transfer_tx: string | null; transfer_attempts: number }>();
  if (fresh?.transfer_tx) return "pending"; // Someone else signed in the meantime.
  if ((fresh?.transfer_attempts ?? 0) >= MAX_TRANSFER_ATTEMPTS) {
    await recordError(db, bounty.id, `${kind.label} gave up after ${MAX_TRANSFER_ATTEMPTS} attempts; needs an operator`, now);
    return "failed";
  }

  let signed: { hash: Hex; raw: Hex };
  try {
    signed = await transfers.sign(bounty.transfer_to as Hex, BigInt(bounty.reward_units));
  } catch (err) {
    // Nothing was sent; for example gas estimation failed because the wallet is empty.
    await recordError(db, bounty.id, `sign failed: ${(err as Error).message}`, now);
    return "failed";
  }

  const stored = await db
    .prepare(
      `UPDATE bounties SET transfer_tx = ?, transfer_raw = ?, transfer_attempts = transfer_attempts + 1, updated_at = ?
       WHERE id = ? AND status = ? AND transfer_tx IS NULL`,
    )
    .bind(signed.hash, signed.raw, now, bounty.id, bounty.status)
    .run();
  if (stored.meta.changes !== 1) return "pending"; // Lost the race; the winner broadcasts.
  console.log(JSON.stringify({ event: `${kind.label}_signed`, bounty_id: bounty.id, tx: signed.hash, to: bounty.transfer_to }));

  try {
    const sent = await transfers.broadcast(signed.raw);
    if (sent === "nonce_used") {
      await discard(signed.hash, `${kind.label} nonce was taken by another transaction`);
      return "pending";
    }
  } catch (err) {
    // Unknown whether it reached the node. The stored bytes are re-sent next time.
    await recordError(db, bounty.id, `broadcast failed: ${(err as Error).message}`, now);
    return "pending";
  }
  return settleAfterSend(signed.hash);

  async function settleAfterSend(hash: Hex): Promise<TransferOutcome> {
    if (waitMs <= 0) return "pending";
    const status = await transfers!.waitFor(hash, waitMs);
    if (status === "success") return finalize(hash);
    if (status === "reverted") {
      await discard(hash, `${kind.label} transaction ${hash} reverted`);
      return "failed";
    }
    return "pending";
  }
}

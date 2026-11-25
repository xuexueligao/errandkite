import { defaultTransfers } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { expireBounties, listPendingTransfers } from "./db.js";
import type { Env } from "./env.js";
import { advanceTransfer, type TokenTransfers, type TransferOutcome } from "./transfers.js";

/** Bounties handled per cron run, to stay well inside the Worker's limits. */
export const TRANSFERS_PER_RUN = 10;

export interface SweepDeps {
  now?: () => number;
  transfers?: (config: Config, env: Env) => TokenTransfers | null;
  transferWaitMs?: number;
}

export interface SweepReport {
  expired: number;
  outcomes: Record<string, TransferOutcome>;
}

/**
 * The cron job: expire overdue bounties into refunding, then move every
 * unfinished payout or refund forward. Each bounty is handled on its own, so
 * one failure does not stop the others.
 */
export async function sweep(env: Env, deps: SweepDeps = {}): Promise<SweepReport> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const config = loadConfig(env);
  let transfers: TokenTransfers | null = null;
  try {
    transfers = (deps.transfers ?? defaultTransfers)(config, env);
  } catch (err) {
    console.error(JSON.stringify({ event: "transfers_config_error", message: (err as Error).message }));
  }

  const expired = await expireBounties(env.DB, now());
  const outcomes: Record<string, TransferOutcome> = {};
  for (const bounty of await listPendingTransfers(env.DB, TRANSFERS_PER_RUN)) {
    try {
      outcomes[bounty.id] = await advanceTransfer(env.DB, transfers, bounty, now(), deps.transferWaitMs ?? 10_000);
    } catch (err) {
      outcomes[bounty.id] = "failed";
      console.error(JSON.stringify({ event: "transfer_error", bounty_id: bounty.id, message: (err as Error).message }));
    }
  }
  console.log(JSON.stringify({ event: "sweep", expired, outcomes }));
  return { expired, outcomes };
}

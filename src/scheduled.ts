import { defaultEscrowReader, defaultTransfers } from "./app.js";
import type { EscrowReader } from "./chain.js";
import { loadConfig, type Config } from "./config.js";
import { expireBounties, listPendingTransfers } from "./db.js";
import type { Env } from "./env.js";
import { LOW_GAS_WEI, type EscrowStatus } from "./ledger.js";
import { pruneRateHits } from "./ratelimit.js";
import { escrowReport, escrowView } from "./stats.js";
import { advanceTransfer, type TokenTransfers, type TransferOutcome } from "./transfers.js";

/** Bounties handled per cron run, to stay well inside the Worker's limits. */
export const TRANSFERS_PER_RUN = 10;

export interface SweepDeps {
  now?: () => number;
  transfers?: (config: Config, env: Env) => TokenTransfers | null;
  transferWaitMs?: number;
  escrowReader?: (config: Config) => EscrowReader | null;
}

export interface SweepReport {
  expired: number;
  outcomes: Record<string, TransferOutcome>;
  escrow: EscrowStatus;
  gasLow: boolean | null;
  prunedRateHits: number;
}

/**
 * The cron job: expire overdue bounties into refunding, then move every
 * unfinished payout or refund forward. Each bounty is handled on its own, so
 * one failure does not stop the others. Last, check the escrow books
 * against the wallet and log the result, so every run leaves a record.
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
  const prunedRateHits = await pruneRateHits(env.DB, now());

  let reader: EscrowReader | null = null;
  try {
    reader = (deps.escrowReader ?? defaultEscrowReader)(config);
  } catch (err) {
    console.error(JSON.stringify({ event: "escrow_reader_error", message: (err as Error).message }));
  }
  const report = await escrowReport(env.DB, reader);
  const escrow = escrowView(report, config.chain.assetDecimals);
  const gasLow = report.gasWei === null ? null : report.gasWei < LOW_GAS_WEI;
  // "short" means money is missing and needs an operator; a low gas balance stops payouts.
  const level = report.status === "short" || gasLow ? "error" : report.status === "ok" ? "log" : "warn";
  console[level](JSON.stringify({ event: "escrow_check", ...escrow }));

  console.log(JSON.stringify({ event: "sweep", expired, outcomes, escrow: report.status, prunedRateHits }));
  return { expired, outcomes, escrow: report.status, gasLow, prunedRateHits };
}

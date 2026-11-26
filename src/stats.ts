import type { EscrowReader } from "./chain.js";
import { PUBLIC_STATUSES, type BountyStatus } from "./db.js";
import { checkEscrow, escrowLedger, LOW_GAS_WEI, type EscrowLedger, type EscrowStatus } from "./ledger.js";
import { unitsToDecimal } from "./money.js";

export interface EscrowReport {
  ledger: EscrowLedger;
  walletUnits: bigint | null;
  gasWei: bigint | null;
  status: EscrowStatus;
}

/** The books from the database, checked against the wallet's on-chain balance. */
export async function escrowReport(db: D1Database, reader: EscrowReader | null): Promise<EscrowReport> {
  const settle = async (read: (() => Promise<bigint>) | undefined, what: string) => {
    if (!read) return null;
    try {
      return await read();
    } catch (err) {
      console.warn(JSON.stringify({ event: "escrow_read_failed", what, message: (err as Error).message }));
      return null;
    }
  };
  const [ledger, walletUnits, gasWei] = await Promise.all([
    escrowLedger(db),
    settle(reader ? () => reader.tokenBalance() : undefined, "token_balance"),
    settle(reader ? () => reader.gasBalance() : undefined, "gas_balance"),
  ]);
  return { ledger, walletUnits, gasWei, status: checkEscrow(ledger, walletUnits) };
}

/** JSON view: bigints as strings, plus decimal amounts for people. */
export function escrowView(report: EscrowReport, decimals: number) {
  const amount = (units: bigint | null) => (units === null ? null : { units: units.toString(), usd: unitsToDecimal(units, decimals) });
  const { ledger } = report;
  return {
    status: report.status,
    received: amount(ledger.received),
    paid_out: amount(ledger.paidOut),
    refunded: amount(ledger.refunded),
    held: amount(ledger.held),
    in_flight: amount(ledger.inFlight),
    wallet_balance: amount(report.walletUnits),
    gas_balance_wei: report.gasWei?.toString() ?? null,
    gas_low: report.gasWei === null ? null : report.gasWei < LOW_GAS_WEI,
  };
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

/** Usage numbers from proposal section 9. Bounties that were never paid for are not counted. */
export async function usageStats(db: D1Database) {
  const statusList = PUBLIC_STATUSES.map((s) => `'${s}'`).join(", ");
  const [byStatus, answers, payers, firstAnswers] = await db.batch([
    db.prepare(`SELECT status, source, COUNT(*) AS n FROM bounties WHERE status IN (${statusList}) GROUP BY status, source`),
    db.prepare(`SELECT COUNT(*) AS answers, COUNT(DISTINCT payout_address) AS answerers FROM answers`),
    db.prepare(`SELECT COUNT(DISTINCT payer) AS payers FROM bounties WHERE status IN (${statusList})`),
    db.prepare(
      `SELECT MIN(a.created_at) - b.created_at AS seconds FROM bounties b JOIN answers a ON a.bounty_id = b.id
       WHERE b.status IN (${statusList}) GROUP BY b.id`,
    ),
  ]);

  const status = Object.fromEntries(PUBLIC_STATUSES.map((s) => [s, 0])) as Record<BountyStatus, number>;
  const source = { agent: 0, manual: 0 };
  for (const row of byStatus.results as { status: BountyStatus; source: "agent" | "manual"; n: number }[]) {
    status[row.status] += row.n;
    source[row.source] += row.n;
  }
  const answerRow = answers.results[0] as { answers: number; answerers: number };
  return {
    bounties: {
      total: source.agent + source.manual,
      by_source: source,
      by_status: status,
      accepted: status.accepting + status.paid,
      refunded: status.refunding + status.refunded,
    },
    answers: { total: answerRow.answers, distinct_answerers: answerRow.answerers },
    distinct_payers: (payers.results[0] as { payers: number }).payers,
    median_seconds_to_first_answer: median((firstAnswers.results as { seconds: number }[]).map((r) => r.seconds)),
  };
}

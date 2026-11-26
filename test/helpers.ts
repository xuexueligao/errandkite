import { env } from "cloudflare:test";
import type { FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { createApp } from "../src/app.js";
import { sweep } from "../src/scheduled.js";
import { FakeChain } from "./fake-chain.js";

export const PAYER = "0x1111111111111111111111111111111111111111";
export const SETTLE_TX = `0x${"ab".repeat(32)}`;

/** Stands in for the pieverse facilitator so tests never touch the network. */
export class FakeFacilitator implements FacilitatorClient {
  verifyCalls = 0;
  settleCalls = 0;
  verifyResult: VerifyResponse = { isValid: true, payer: PAYER };
  settleResult: SettleResponse = { success: true, payer: PAYER, transaction: SETTLE_TX, network: "eip155:2368" };

  async verify(_payload: PaymentPayload, _requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.verifyCalls++;
    return this.verifyResult;
  }

  async settle(_payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls++;
    return { ...this.settleResult, network: requirements.network };
  }

  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:2368" as const }], extensions: [], signers: {} };
  }
}

/** The platform wallet as seen on chain. A balance set to an Error makes that read fail. */
export class FakeEscrow {
  token: bigint | Error = 0n;
  gas: bigint | Error = 10n ** 18n;
  async tokenBalance() {
    if (this.token instanceof Error) throw this.token;
    return this.token;
  }
  async gasBalance() {
    if (this.gas instanceof Error) throw this.gas;
    return this.gas;
  }
}

export interface MakeAppOptions {
  /** null means "payouts not configured". */
  chain?: FakeChain | null;
  clock?: { now: number };
  /** Wallet balances for /api/stats and the cron escrow check; null means none can be read. */
  escrow?: FakeEscrow | null;
}

export function makeApp(options: MakeAppOptions = {}) {
  const facilitator = new FakeFacilitator();
  const chain = options.chain === undefined ? new FakeChain() : options.chain;
  const clock = options.clock ?? { now: Math.floor(Date.now() / 1000) };
  const escrow = options.escrow === undefined ? new FakeEscrow() : options.escrow;
  const deps = { now: () => clock.now, transfers: () => chain, transferWaitMs: 1, escrowReader: () => escrow };
  const app = createApp({ facilitator, statsCacheSeconds: 0, ...deps });
  const request = (path: string, init?: RequestInit) => app.request(path, init, env);
  const runSweep = () => sweep(env, deps);
  return { app, facilitator, request, chain, clock, escrow, runSweep };
}

export const postJson = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/**
 * Builds a PAYMENT-SIGNATURE header that accepts the challenge's first option.
 * The signature is a placeholder: the fake facilitator decides validity.
 */
export function paymentHeaderFor(paymentRequiredHeader: string): string {
  const required = decodePaymentRequiredHeader(paymentRequiredHeader);
  const accepted = required.accepts[0];
  const payload: PaymentPayload = {
    x402Version: required.x402Version,
    resource: required.resource,
    accepted,
    payload: {
      signature: `0x${"11".repeat(65)}`,
      authorization: {
        from: PAYER,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"22".repeat(32)}`,
      },
    },
  };
  return encodePaymentSignatureHeader(payload);
}

export async function countBounties(status?: string): Promise<number> {
  const stmt = status
    ? env.DB.prepare("SELECT COUNT(*) AS n FROM bounties WHERE status = ?").bind(status)
    : env.DB.prepare("SELECT COUNT(*) AS n FROM bounties");
  return (await stmt.first<{ n: number }>())!.n;
}

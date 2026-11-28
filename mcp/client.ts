// Errandkite client used by the MCP server. It has no Node-only imports, so
// tests run it against the real Worker app inside the Workers runtime.
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { ClientEvmSigner } from "@x402/evm";

export const KITE_TESTNET = "eip155:2368";
export const PIEUSD = "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A";
const PIEUSD_DECIMALS = 18;

/** What the agent keeps for each bounty it posted. The manage token is the only proof of ownership. */
export interface SavedBounty {
  id: string;
  manage_token: string;
  question: string;
  reward_usd: string;
  posted_at: number;
}

export interface TokenStore {
  get(id: string): Promise<SavedBounty | undefined>;
  save(bounty: SavedBounty): Promise<void>;
  list(): Promise<SavedBounty[]>;
}

export class MemoryTokenStore implements TokenStore {
  private items = new Map<string, SavedBounty>();
  async get(id: string) {
    return this.items.get(id);
  }
  async save(bounty: SavedBounty) {
    this.items.set(bounty.id, bounty);
  }
  async list() {
    return [...this.items.values()];
  }
}

export interface ClientOptions {
  /** e.g. https://errandkite.example.workers.dev */
  baseUrl: string;
  /** Signs the x402 payment. Without it, post_bounty explains how to configure one. */
  signer: ClientEvmSigner | null;
  /** The most this client will ever pay for one bounty, as a decimal string. */
  maxRewardUsd: string;
  store: TokenStore;
  fetch?: typeof fetch;
}

/** An error worth showing to the agent as is. */
export class ErrandkiteError extends Error {
  readonly status?: number;
  readonly code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** "0.10" -> 100000000000000000n with integer math; null if it is not a plain decimal. */
export function usdToUnits(value: string): bigint | null {
  const match = /^(\d{1,12})(?:\.(\d{1,18}))?$/.exec(value.trim());
  if (!match) return null;
  return BigInt(match[1] + (match[2] ?? "").padEnd(PIEUSD_DECIMALS, "0"));
}

export interface PostBountyInput {
  question: string;
  reward_usd: string;
  ttl_seconds?: number;
  /** "manual" marks a human test, so stats keep it apart from real agent bounties. */
  source?: "agent" | "manual";
}

export class ErrandkiteClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRewardUnits: bigint;
  private readonly options: ClientOptions;

  constructor(options: ClientOptions) {
    this.options = options;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    const max = usdToUnits(options.maxRewardUsd);
    if (max === null || max <= 0n) throw new ErrandkiteError(`maxRewardUsd must be a positive decimal, got "${options.maxRewardUsd}"`);
    this.maxRewardUnits = max;
  }

  /** Link to the bounty's public page, for the agent to share or show. */
  pageUrl(id: string) {
    return `${this.baseUrl}/bounty?id=${encodeURIComponent(id)}`;
  }

  private async call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (err) {
      throw new ErrandkiteError(`Could not reach Errandkite at ${this.baseUrl}: ${(err as Error).message}`);
    }
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      // Not JSON (e.g. a 402 with an empty body).
    }
    return { status: res.status, body, headers: res.headers };
  }

  private fail(status: number, body: any): never {
    const error = body?.error;
    const details = Array.isArray(error?.details) ? ` (${error.details.map((d: any) => `${d.field}: ${d.message}`).join("; ")})` : "";
    throw new ErrandkiteError(`${error?.message ?? `HTTP ${status}`}${details}`, status, error?.code);
  }

  private async owned(id: string): Promise<SavedBounty> {
    const saved = await this.options.store.get(id);
    if (!saved) throw new ErrandkiteError(`No manage token for ${id}. Only bounties posted from this MCP server can be managed here.`);
    return saved;
  }

  private ownerHeaders(saved: SavedBounty, json = false) {
    return { Authorization: `Bearer ${saved.manage_token}`, ...(json ? { "content-type": "application/json" } : {}) };
  }

  /**
   * Checks the 402 challenge before signing anything: it must ask for pieUSD
   * on the Kite testnet, exactly the reward, and no more than the cap.
   */
  private pickRequirement(required: PaymentRequired, rewardUnits: bigint): PaymentRequirements {
    const match = required.accepts.find(
      (r) => r.scheme === "exact" && r.network === KITE_TESTNET && r.asset.toLowerCase() === PIEUSD.toLowerCase(),
    );
    if (!match) throw new ErrandkiteError("The server did not offer a pieUSD payment on the Kite testnet; nothing was paid.");
    if (BigInt(match.amount) !== rewardUnits) {
      throw new ErrandkiteError(`The server asked for ${match.amount} base units but the reward is ${rewardUnits}; nothing was paid.`);
    }
    return match;
  }

  async postBounty(input: PostBountyInput) {
    const rewardUnits = usdToUnits(input.reward_usd);
    if (rewardUnits === null || rewardUnits <= 0n) throw new ErrandkiteError('reward_usd must be a positive decimal string such as "0.10".');
    if (rewardUnits > this.maxRewardUnits) {
      throw new ErrandkiteError(`reward_usd ${input.reward_usd} is above this client's limit of ${this.options.maxRewardUsd} (ERRANDKITE_MAX_REWARD_USD).`);
    }
    const signer = this.options.signer;
    if (!signer) throw new ErrandkiteError("No payer wallet is configured. Set ERRANDKITE_PAYER_KEY to a Kite testnet private key holding pieUSD.");

    const body = JSON.stringify({ question: input.question, reward_usd: input.reward_usd, ttl_seconds: input.ttl_seconds, source: input.source ?? "agent" });
    const init = { method: "POST", headers: { "content-type": "application/json" }, body };

    // 1. Ask without paying. Bad input comes back as 400 here, before any signature.
    const first = await this.call("/v1/bounties", init);
    if (first.status !== 402) this.fail(first.status, first.body);

    // 2. Check the terms, then sign the EIP-3009 authorization locally.
    // pieUSD is not one of the SDK's default assets, so it is allowed explicitly,
    // capped at exactly this reward: the SDK refuses to sign for more.
    const client = x402Client.fromConfig({
      schemes: [],
      spendControls: { allowedAssets: [{ network: KITE_TESTNET, asset: PIEUSD, maxAmountPerPayment: rewardUnits.toString() }] },
    });
    registerExactEvmScheme(client, { signer, networks: [KITE_TESTNET] });
    const http = new x402HTTPClient(client);
    const required = http.getPaymentRequiredResponse((name) => first.headers.get(name), first.body);
    const requirement = this.pickRequirement(required, rewardUnits);
    const payload = await http.createPaymentPayload({ ...required, accepts: [requirement] });

    // 3. Send the same body with the payment.
    const paid = await this.call("/v1/bounties", { ...init, headers: { ...init.headers, ...http.encodePaymentSignatureHeader(payload) } });
    if (paid.status !== 201) {
      if (paid.status === 402) {
        const reason = (() => {
          try {
            return http.getPaymentRequiredResponse((name) => paid.headers.get(name), paid.body).error;
          } catch {
            return undefined;
          }
        })();
        throw new ErrandkiteError(`The payment was not accepted${reason ? `: ${reason}` : ""}. Check that the payer wallet holds enough pieUSD.`, 402, "payment_rejected");
      }
      this.fail(paid.status, paid.body);
    }
    const created = paid.body as { id: string; manage_token: string; reward_usd: string; expires_at: number; payment_tx: string; status: string };
    await this.options.store.save({ id: created.id, manage_token: created.manage_token, question: input.question, reward_usd: created.reward_usd, posted_at: Math.floor(Date.now() / 1000) });
    return {
      id: created.id,
      status: created.status,
      reward_usd: created.reward_usd,
      expires_at: created.expires_at,
      payment_tx: created.payment_tx,
      page_url: this.pageUrl(created.id),
    };
  }

  async getBounty(id: string) {
    const res = await this.call(`/api/bounties/${encodeURIComponent(id)}`);
    if (res.status !== 200) this.fail(res.status, res.body);
    return { ...res.body.bounty, page_url: this.pageUrl(id) };
  }

  async getAnswers(id: string) {
    const saved = await this.owned(id);
    const res = await this.call(`/api/bounties/${encodeURIComponent(id)}/answers`, { headers: this.ownerHeaders(saved) });
    if (res.status !== 200) this.fail(res.status, res.body);
    return res.body as { bounty_status: string; accepted_answer_id: string | null; answers: { id: string; answer: string; payout_address: string; created_at: number; accepted: boolean }[] };
  }

  async acceptAnswer(id: string, answerId: string) {
    const saved = await this.owned(id);
    const res = await this.call(`/api/bounties/${encodeURIComponent(id)}/accept`, {
      method: "POST",
      headers: this.ownerHeaders(saved, true),
      body: JSON.stringify({ answer_id: answerId }),
    });
    if (res.status !== 200) this.fail(res.status, res.body);
    return res.body.bounty;
  }

  async cancelBounty(id: string) {
    const saved = await this.owned(id);
    const res = await this.call(`/api/bounties/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: this.ownerHeaders(saved) });
    if (res.status !== 200) this.fail(res.status, res.body);
    return res.body.bounty;
  }

  async listMyBounties() {
    return (await this.options.store.list()).map(({ manage_token: _hidden, ...rest }) => ({ ...rest, page_url: this.pageUrl(rest.id) }));
  }
}

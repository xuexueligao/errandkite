/** Bindings and variables the Worker receives (see wrangler.jsonc and .dev.vars). */
export interface Env {
  DB: D1Database;
  KITE_NETWORK: string;
  PAY_TO: string;
  MIN_REWARD_USD: string;
  MAX_REWARD_USD: string;
  /** Optional override, e.g. for a self-hosted facilitator. */
  FACILITATOR_URL?: string;
  /** Secret (wrangler secret put). Signs payouts and refunds from PAY_TO. Testnet only. */
  PLATFORM_PRIVATE_KEY?: string;
}

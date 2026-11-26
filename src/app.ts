import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { AssetAmount } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { createChainTransfers, createEscrowReader, type EscrowReader } from "./chain.js";
import {
  activateBounty,
  getAnswer,
  getBounty,
  getBountyWithCount,
  insertAnswer,
  insertPendingBounty,
  listAnswers,
  listPublicBounties,
  markAccepting,
  markCancelled,
  PUBLIC_STATUSES,
  voidBounty,
  type BountyRow,
  type BountyStatus,
  type BountyWithCount,
} from "./db.js";
import type { Env } from "./env.js";
import { kiteMoneyParser } from "./kite.js";
import { ANSWER_LIMITS, rateKey, recordHits, retryAfter, type RateLimit } from "./ratelimit.js";
import { escrowReport, escrowView, usageStats } from "./stats.js";
import { hashToken, newAnswerId, newBountyId, newManageToken } from "./tokens.js";
import { advanceTransfer, type TokenTransfers } from "./transfers.js";
import { parseAnswerInput, parseBountyInput, type BountyInput } from "./validation.js";

type Vars = { config: Config; bountyInput: BountyInput; createdBountyId: string; ownedBounty: BountyRow };
export type AppEnv = { Bindings: Env; Variables: Vars };

export interface AppDeps {
  /** Injected in tests; production talks to the pieverse facilitator over HTTP. */
  facilitator?: FacilitatorClient;
  now?: () => number;
  /** Injected in tests. Production signs with PLATFORM_PRIVATE_KEY; null when it is not set. */
  transfers?: (config: Config, env: Env) => TokenTransfers | null;
  /** How long accept/cancel wait for the transfer receipt before answering. */
  transferWaitMs?: number;
  /** Injected in tests. Production reads the wallet balance over RPC. */
  escrowReader?: (config: Config) => EscrowReader | null;
  /** How long one isolate reuses a /api/stats response. */
  statsCacheSeconds?: number;
}

/** Builds the transfer client from the environment, or null when no key is configured. */
export function defaultTransfers(config: Config, env: Env): TokenTransfers | null {
  return env.PLATFORM_PRIVATE_KEY ? createChainTransfers(config, env.PLATFORM_PRIVATE_KEY) : null;
}

export function defaultEscrowReader(config: Config): EscrowReader {
  return createEscrowReader(config);
}

const errorBody = (code: string, message: string, details?: unknown) => ({ error: { code, message, ...(details ? { details } : {}) } });

/** Transaction of the final transfer, labelled by what it is. */
function transferView(row: BountyRow) {
  const payout = row.status === "accepting" || row.status === "paid";
  const refund = row.status === "refunding" || row.status === "refunded";
  return {
    payout_tx: payout ? row.transfer_tx : null,
    payout_to: payout ? row.transfer_to : null,
    refund_tx: refund ? row.transfer_tx : null,
  };
}

/** Public view of a bounty. Never includes the manage token hash, answer texts or the signed transaction. */
function publicBounty(row: BountyWithCount) {
  return {
    id: row.id,
    status: row.status,
    question: row.question,
    reward_usd: row.reward_usd,
    reward_units: row.reward_units,
    network: row.network,
    asset: row.asset,
    source: row.source,
    payer: row.payer,
    payment_tx: row.payment_tx,
    created_at: row.created_at,
    expires_at: row.expires_at,
    answer_count: row.answer_count,
    ...transferView(row),
  };
}

/** What the poster sees: the public view plus the accepted answer and any transfer error. */
function ownerBounty(row: BountyWithCount) {
  return { ...publicBounty(row), accepted_answer_id: row.accepted_answer_id, transfer_error: row.transfer_error };
}

export function createApp(deps: AppDeps = {}) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const makeTransfers = deps.transfers ?? defaultTransfers;
  const transferWaitMs = deps.transferWaitMs ?? 20_000;
  const makeEscrowReader = deps.escrowReader ?? defaultEscrowReader;
  const statsCacheSeconds = deps.statsCacheSeconds ?? 30;
  let statsCache: { at: number; body: unknown } | undefined;
  const app = new Hono<AppEnv>();

  // One payment middleware per isolate and configuration.
  let payment: { key: string; handler: MiddlewareHandler } | undefined;
  const paymentFor = (config: Config): MiddlewareHandler => {
    const key = JSON.stringify([config.chain.network, config.payTo, config.facilitatorUrl]);
    if (payment?.key === key) return payment.handler;
    const facilitator = deps.facilitator ?? new HTTPFacilitatorClient({ url: config.facilitatorUrl });
    const server = new x402ResourceServer(facilitator).register(config.chain.network, new ExactEvmScheme());
    const parsePrice = kiteMoneyParser(config.chain);
    const handler = paymentMiddleware(
      {
        "POST /v1/bounties": {
          accepts: {
            scheme: "exact",
            network: config.chain.network,
            payTo: config.payTo,
            maxTimeoutSeconds: 120,
            // The 402 challenge asks for exactly the reward in the request body.
            // The body was already validated, so the string goes to the
            // official Kite money parser, which converts it with integer math.
            price: async (context) => {
              const parsed = parseBountyInput(await context.adapter.getBody?.(), config);
              if (!parsed.ok) throw new Error("bounty body changed after validation");
              const amount = await parsePrice(parsed.value.rewardUsd, config.chain.network);
              if (!amount) throw new Error("no price for network");
              return amount as AssetAmount;
            },
          },
          description: "Post a bounty for a human to answer. The payment is the reward, held in escrow.",
          mimeType: "application/json",
        },
      },
      server,
    );
    payment = { key, handler };
    return handler;
  };

  app.use("*", async (c, next) => {
    try {
      c.set("config", loadConfig(c.env));
    } catch (err) {
      if (err instanceof ConfigError || err instanceof Error) {
        console.error(JSON.stringify({ event: "config_error", message: err.message }));
        return c.json(errorBody("server_misconfigured", "The service is not configured correctly."), 500);
      }
      throw err;
    }
    await next();
  });

  app.get("/healthz", (c) => {
    const { chain, payTo, minRewardUsd, maxRewardUsd } = c.get("config");
    return c.json({ ok: true, network: chain.network, asset: chain.assetAddress, asset_symbol: chain.assetSymbol, pay_to: payTo, min_reward_usd: minRewardUsd, max_reward_usd: maxRewardUsd });
  });

  // 1. Validate before payment: a bad request gets 400 and is never asked to pay.
  // 2. After the handler and settlement: activate the bounty, or void it if the payment did not settle.
  app.post("/v1/bounties", async (c, next) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody("invalid_json", "Request body must be JSON."), 400);
    }
    const parsed = parseBountyInput(body, c.get("config"));
    if (!parsed.ok) return c.json(errorBody("invalid_request", "The bounty is not valid.", parsed.errors), 400);
    c.set("bountyInput", parsed.value);

    await next();

    const id = c.get("createdBountyId");
    if (!id) return; // The handler did not run, e.g. the 402 challenge.

    const header = c.res.headers.get("PAYMENT-RESPONSE");
    const settled = c.res.status < 400 && header ? decodePaymentResponseHeader(header) : null;
    if (!settled?.success || !settled.transaction) {
      await voidBounty(c.env.DB, id, now());
      console.warn(JSON.stringify({ event: "bounty_void", bounty_id: id, status: c.res.status }));
      return;
    }

    const activated = await activateBounty(c.env.DB, id, settled.payer ?? null, settled.transaction, now());
    if (!activated) {
      // The money moved but the row could not be updated. Keep the evidence so it can be reconciled.
      console.error(JSON.stringify({ event: "bounty_activate_failed", bounty_id: id, payment_tx: settled.transaction }));
      const headers = new Headers(c.res.headers);
      c.res = undefined;
      c.res = new Response(
        JSON.stringify(errorBody("activation_failed", "Payment settled but the bounty could not be opened. Keep this response.", { bounty_id: id, payment_tx: settled.transaction })),
        { status: 500, headers },
      );
      return;
    }

    console.log(JSON.stringify({ event: "bounty_open", bounty_id: id, payment_tx: settled.transaction }));
    const created = (await c.res.json()) as Record<string, unknown>;
    const headers = new Headers(c.res.headers);
    c.res = undefined;
    c.res = new Response(JSON.stringify({ ...created, status: "open", payer: settled.payer ?? null, payment_tx: settled.transaction }), { status: 201, headers });
  });

  app.post("/v1/bounties", (c, next) => paymentFor(c.get("config"))(c, next));

  // Runs only after the payment was verified; settlement happens after this returns.
  app.post("/v1/bounties", async (c) => {
    const input = c.get("bountyInput");
    const { chain } = c.get("config");
    const id = newBountyId();
    const manageToken = newManageToken();
    const createdAt = now();
    await insertPendingBounty(c.env.DB, {
      id,
      question: input.question,
      reward_usd: input.rewardUsd,
      reward_units: input.rewardUnits.toString(),
      network: chain.network,
      asset: chain.assetAddress,
      source: input.source,
      manage_token_hash: await hashToken(manageToken),
      created_at: createdAt,
      expires_at: createdAt + input.ttlSeconds,
      updated_at: createdAt,
    });
    c.set("createdBountyId", id);
    return c.json({ id, manage_token: manageToken, reward_usd: input.rewardUsd, reward_units: input.rewardUnits.toString(), expires_at: createdAt + input.ttlSeconds }, 201);
  });

  app.get("/api/bounties", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !PUBLIC_STATUSES.includes(status as BountyStatus)) {
      return c.json(errorBody("invalid_request", `status must be one of ${PUBLIC_STATUSES.join(", ")}`), 400);
    }
    const limitRaw = c.req.query("limit") ?? "20";
    const limit = Number(limitRaw);
    if (!/^\d+$/.test(limitRaw) || limit < 1 || limit > 100) return c.json(errorBody("invalid_request", "limit must be 1 to 100"), 400);
    const beforeRaw = c.req.query("before");
    if (beforeRaw !== undefined && !/^\d+$/.test(beforeRaw)) return c.json(errorBody("invalid_request", "before must be a unix timestamp"), 400);
    const rows = await listPublicBounties(c.env.DB, { status: status as BountyStatus | undefined, limit, before: beforeRaw ? Number(beforeRaw) : undefined });
    return c.json({ bounties: rows.map(publicBounty), next_before: rows.length === limit ? rows[rows.length - 1].created_at : null });
  });

  app.get("/api/bounties/:id", async (c) => {
    const row = await getBountyWithCount(c.env.DB, c.req.param("id"));
    if (!row || !PUBLIC_STATUSES.includes(row.status)) return c.json(errorBody("not_found", "No such bounty."), 404);
    return c.json({ bounty: publicBounty(row) });
  });

  // Public usage numbers and the escrow books checked against the wallet.
  app.get("/api/stats", async (c) => {
    c.header("Cache-Control", `public, max-age=${statsCacheSeconds}`);
    const at = now();
    if (statsCache && at - statsCache.at < statsCacheSeconds) return c.json(statsCache.body);
    const config = c.get("config");
    let reader: EscrowReader | null = null;
    try {
      reader = makeEscrowReader(config);
    } catch (err) {
      console.error(JSON.stringify({ event: "escrow_reader_error", message: (err as Error).message }));
    }
    const [usage, escrow] = await Promise.all([usageStats(c.env.DB), escrowReport(c.env.DB, reader)]);
    const body = {
      network: config.chain.network,
      asset: config.chain.assetAddress,
      asset_symbol: config.chain.assetSymbol,
      escrow_address: config.payTo,
      generated_at: at,
      ...usage,
      escrow: escrowView(escrow, config.chain.assetDecimals),
    };
    statsCache = { at, body };
    return c.json(body);
  });

  // Anyone can answer; no account, just a payout address.
  app.post("/api/bounties/:id/answers", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody("invalid_json", "Request body must be JSON."), 400);
    }
    const bounty = await getBounty(c.env.DB, c.req.param("id"));
    if (!bounty || !PUBLIC_STATUSES.includes(bounty.status)) return c.json(errorBody("not_found", "No such bounty."), 404);
    const parsed = parseAnswerInput(body, c.get("config"));
    if (!parsed.ok) return c.json(errorBody("invalid_request", "The answer is not valid.", parsed.errors), 400);

    // Limits per client IP and per payout address. Cloudflare always sets
    // CF-Connecting-IP; without it (local tools) only the address limit applies.
    const createdAt = now();
    const ip = c.req.header("CF-Connecting-IP");
    const hits: { limit: RateLimit; key: string }[] = [{ limit: ANSWER_LIMITS.address, key: await rateKey(parsed.value.payoutAddress) }];
    if (ip) hits.push({ limit: ANSWER_LIMITS.ip, key: await rateKey(ip) });
    for (const hit of hits) {
      const wait = await retryAfter(c.env.DB, hit.limit, hit.key, createdAt);
      if (wait > 0) {
        c.header("Retry-After", String(wait));
        return c.json(errorBody("rate_limited", `Too many answers. Try again in ${wait} seconds.`, { retry_after: wait }), 429);
      }
    }

    const id = newAnswerId();
    const result = await insertAnswer(c.env.DB, {
      id,
      bounty_id: bounty.id,
      body: parsed.value.answer,
      payout_address: parsed.value.payoutAddress,
      created_at: createdAt,
    });
    if (result === "closed") return c.json(errorBody("bounty_closed", "This bounty no longer takes answers."), 409);
    if (result === "duplicate") return c.json(errorBody("duplicate_answer", "This address already answered this bounty."), 409);
    if (result === "too_many") return c.json(errorBody("too_many_answers", "This bounty has reached its answer limit."), 409);
    await recordHits(c.env.DB, hits, createdAt);
    return c.json({ answer: { id, bounty_id: bounty.id, payout_address: parsed.value.payoutAddress, created_at: createdAt } }, 201);
  });

  // Reading answers, accepting and cancelling need the manage token returned when the bounty was posted.
  const requireManageToken: MiddlewareHandler<AppEnv> = async (c, next) => {
    const auth = (c.req.header("Authorization") ?? "").trim();
    const match = /^Bearer\s+(mt_[0-9a-f]{64})$/.exec(auth);
    if (!match) return c.json(errorBody("unauthorized", "Send the manage token as: Authorization: Bearer mt_…"), 401);
    const bounty = await getBounty(c.env.DB, c.req.param("id") ?? "");
    // Same answer for "no such bounty" and "wrong token", so the endpoint cannot be used to probe ids.
    if (!bounty || !PUBLIC_STATUSES.includes(bounty.status) || bounty.manage_token_hash !== (await hashToken(match[1]))) {
      return c.json(errorBody("forbidden", "The manage token does not match this bounty."), 403);
    }
    c.set("ownedBounty", bounty);
    await next();
  };

  app.get("/api/bounties/:id/answers", requireManageToken, async (c) => {
    const bounty = c.get("ownedBounty");
    const answers = await listAnswers(c.env.DB, bounty.id);
    return c.json({
      bounty_status: bounty.status,
      accepted_answer_id: bounty.accepted_answer_id,
      answers: answers.map((a) => ({
        id: a.id,
        answer: a.body,
        payout_address: a.payout_address,
        created_at: a.created_at,
        accepted: a.id === bounty.accepted_answer_id,
      })),
    });
  });

  // Tries the transfer once right away, so on a quick chain one call is enough.
  // Whatever is left (pending receipt, RPC error) is finished by the cron job.
  const startTransfer = async (c: Context<AppEnv>, id: string) => {
    let transfers: TokenTransfers | null = null;
    try {
      transfers = makeTransfers(c.get("config"), c.env);
    } catch (err) {
      console.error(JSON.stringify({ event: "transfers_config_error", message: (err as Error).message }));
    }
    const row = await getBounty(c.env.DB, id);
    if (row) {
      try {
        await advanceTransfer(c.env.DB, transfers, row, now(), transferWaitMs);
      } catch (err) {
        console.error(JSON.stringify({ event: "transfer_error", bounty_id: id, message: (err as Error).message }));
      }
    }
    const updated = await getBountyWithCount(c.env.DB, id);
    return c.json({ bounty: ownerBounty(updated!) });
  };

  app.post("/api/bounties/:id/accept", requireManageToken, async (c) => {
    const bounty = c.get("ownedBounty");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody("invalid_json", "Request body must be JSON."), 400);
    }
    const answerId = (body as { answer_id?: unknown } | null)?.answer_id;
    if (typeof answerId !== "string") return c.json(errorBody("invalid_request", "answer_id is required."), 400);
    const answer = await getAnswer(c.env.DB, bounty.id, answerId);
    if (!answer) return c.json(errorBody("not_found", "No such answer on this bounty."), 404);

    if (!(await markAccepting(c.env.DB, bounty.id, answer, now()))) {
      const current = await getBounty(c.env.DB, bounty.id);
      const expired = current !== null && (current.status === "open" || current.status === "answered") && current.expires_at <= now();
      if (expired) return c.json(errorBody("bounty_expired", "The bounty has expired and will be refunded."), 409);
      return c.json(errorBody("bounty_not_acceptable", `The bounty is ${current?.status}; an answer can only be accepted once.`), 409);
    }
    console.log(JSON.stringify({ event: "bounty_accepting", bounty_id: bounty.id, answer_id: answer.id }));
    return startTransfer(c, bounty.id);
  });

  app.post("/api/bounties/:id/cancel", requireManageToken, async (c) => {
    const bounty = c.get("ownedBounty");
    if (!(await markCancelled(c.env.DB, bounty.id, now()))) {
      return c.json(errorBody("bounty_not_cancellable", "Only an open bounty without answers can be cancelled."), 409);
    }
    console.log(JSON.stringify({ event: "bounty_cancelled", bounty_id: bounty.id }));
    return startTransfer(c, bounty.id);
  });

  app.notFound((c) => c.json(errorBody("not_found", "No such route."), 404));
  app.onError((err, c) => {
    console.error(JSON.stringify({ event: "unhandled_error", message: err.message, path: c.req.path }));
    return c.json(errorBody("internal_error", "Something went wrong."), 500);
  });

  return app;
}

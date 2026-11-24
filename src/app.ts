import { Hono, type MiddlewareHandler } from "hono";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { AssetAmount } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { activateBounty, getBounty, insertPendingBounty, listPublicBounties, PUBLIC_STATUSES, voidBounty, type BountyRow, type BountyStatus } from "./db.js";
import type { Env } from "./env.js";
import { kiteMoneyParser } from "./kite.js";
import { hashToken, newBountyId, newManageToken } from "./tokens.js";
import { parseBountyInput, type BountyInput } from "./validation.js";

type Vars = { config: Config; bountyInput: BountyInput; createdBountyId: string };
export type AppEnv = { Bindings: Env; Variables: Vars };

export interface AppDeps {
  /** Injected in tests; production talks to the pieverse facilitator over HTTP. */
  facilitator?: FacilitatorClient;
  now?: () => number;
}

const errorBody = (code: string, message: string, details?: unknown) => ({ error: { code, message, ...(details ? { details } : {}) } });

/** Public view of a bounty. Never includes the manage token hash. */
function publicBounty(row: BountyRow) {
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
  };
}

export function createApp(deps: AppDeps = {}) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
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
    const row = await getBounty(c.env.DB, c.req.param("id"));
    if (!row || !PUBLIC_STATUSES.includes(row.status)) return c.json(errorBody("not_found", "No such bounty."), 404);
    return c.json({ bounty: publicBounty(row) });
  });

  app.notFound((c) => c.json(errorBody("not_found", "No such route."), 404));
  app.onError((err, c) => {
    console.error(JSON.stringify({ event: "unhandled_error", message: err.message, path: c.req.path }));
    return c.json(errorBody("internal_error", "Something went wrong."), 500);
  });

  return app;
}

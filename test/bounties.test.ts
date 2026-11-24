import { env } from "cloudflare:test";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { KITE_TESTNET } from "../src/kite.js";
import { hashToken } from "../src/tokens.js";
import { countBounties, makeApp, PAYER, paymentHeaderFor, postJson, SETTLE_TX } from "./helpers.js";

const PAY_TO = "0x7ec512bAcF9F3a1EC024F9bC5AbFDA3836ADDEa9";
const bounty = { question: "Does example.com load on a phone in Brazil?", reward_usd: "0.10", ttl_seconds: 3600 };

async function challenge(request: ReturnType<typeof makeApp>["request"], body: unknown = bounty) {
  const res = await request("/v1/bounties", postJson(body));
  expect(res.status).toBe(402);
  const header = res.headers.get("PAYMENT-REQUIRED");
  expect(header).toBeTruthy();
  return header!;
}

async function postPaid(request: ReturnType<typeof makeApp>["request"], body: unknown = bounty) {
  const header = await challenge(request, body);
  return request("/v1/bounties", postJson(body, { "PAYMENT-SIGNATURE": paymentHeaderFor(header) }));
}

describe("GET /healthz", () => {
  it("reports the Kite testnet settlement settings", async () => {
    const { request } = makeApp();
    const res = await request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, network: "eip155:2368", asset: KITE_TESTNET.assetAddress, asset_symbol: "pieUSD", pay_to: PAY_TO });
  });
});

describe("POST /v1/bounties without payment", () => {
  it("returns a Kite testnet x402 challenge for exactly the posted reward", async () => {
    const { request } = makeApp();
    const required = decodePaymentRequiredHeader(await challenge(request));
    expect(required.x402Version).toBe(2);
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:2368",
      asset: KITE_TESTNET.assetAddress,
      payTo: PAY_TO,
      amount: "100000000000000000", // 0.10 pieUSD, 18 decimals
      extra: { name: "pieUSD", version: "1" },
    });
    expect(await countBounties()).toBe(0);
  });

  it("prices each request by its own reward", async () => {
    const { request } = makeApp();
    for (const [reward, units] of [["0.01", "10000000000000000"], ["0.123456789012345678", "123456789012345678"], ["1", "1000000000000000000"]]) {
      const required = decodePaymentRequiredHeader(await challenge(request, { ...bounty, reward_usd: reward }));
      expect(required.accepts[0].amount, reward).toBe(units);
    }
  });
});

describe("POST /v1/bounties with an invalid body", () => {
  it.each([
    ["malformed JSON", "{not json"],
    ["reward above the maximum", { ...bounty, reward_usd: "1.01" }],
    ["reward below the minimum", { ...bounty, reward_usd: "0.001" }],
    ["reward sent as a number", { ...bounty, reward_usd: 0.1 }],
    ["missing question", { reward_usd: "0.10" }],
  ])("returns 400 for %s and never asks for payment", async (_name, body) => {
    const { request, facilitator } = makeApp();
    const res = await request("/v1/bounties", postJson(body));
    expect(res.status).toBe(400);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect((await res.json()) as object).toHaveProperty("error.code");
    expect(facilitator.verifyCalls + facilitator.settleCalls).toBe(0);
  });

  it("returns 400 even when a payment signature is attached, without verifying or settling it", async () => {
    const { request, facilitator } = makeApp();
    const header = await challenge(request);
    const res = await request("/v1/bounties", postJson({ ...bounty, reward_usd: "5" }, { "PAYMENT-SIGNATURE": paymentHeaderFor(header) }));
    expect(res.status).toBe(400);
    expect(facilitator.verifyCalls + facilitator.settleCalls).toBe(0);
    expect(await countBounties()).toBe(0);
  });
});

describe("POST /v1/bounties with payment", () => {
  it("opens the bounty after settlement and returns the manage token once", async () => {
    const { request, facilitator } = makeApp();
    const res = await postPaid(request);
    expect(res.status).toBe(201);
    expect(facilitator.settleCalls).toBe(1);

    const body = (await res.json()) as Record<string, string | number>;
    expect(body).toMatchObject({ status: "open", reward_usd: "0.10", reward_units: "100000000000000000", payer: PAYER, payment_tx: SETTLE_TX });
    expect(body.id).toMatch(/^bty_[0-9a-f]{32}$/);
    expect(body.manage_token).toMatch(/^mt_[0-9a-f]{64}$/);
    expect(decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!).transaction).toBe(SETTLE_TX);

    const row = await env.DB.prepare("SELECT * FROM bounties WHERE id = ?").bind(body.id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: "open", payer: PAYER, payment_tx: SETTLE_TX, reward_units: "100000000000000000", network: "eip155:2368", source: "agent" });
    expect(row!.manage_token_hash).toBe(await hashToken(String(body.manage_token)));
    expect(JSON.stringify(row)).not.toContain(String(body.manage_token));
    expect(Number(row!.expires_at) - Number(row!.created_at)).toBe(3600);
  });

  it("voids the bounty when settlement fails, and does not list it", async () => {
    const { request, facilitator } = makeApp();
    facilitator.settleResult = { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:2368" };
    const res = await postPaid(request);
    expect(res.status).toBe(402);
    expect(await countBounties("void")).toBe(1);
    expect(await countBounties("open")).toBe(0);
    const list = (await (await request("/api/bounties")).json()) as { bounties: unknown[] };
    expect(list.bounties).toHaveLength(0);
  });

  it("creates nothing when the facilitator rejects the payment", async () => {
    const { request, facilitator } = makeApp();
    facilitator.verifyResult = { isValid: false, invalidReason: "invalid_signature" };
    const res = await postPaid(request);
    expect(res.status).toBe(402);
    expect(facilitator.settleCalls).toBe(0);
    expect(await countBounties()).toBe(0);
  });
});

describe("public reads", () => {
  it("lists and shows open bounties without secrets", async () => {
    const { request } = makeApp();
    const created = (await (await postPaid(request)).json()) as { id: string; manage_token: string };

    const list = (await (await request("/api/bounties")).json()) as { bounties: Record<string, unknown>[]; next_before: number | null };
    expect(list.bounties.map((b) => b.id)).toEqual([created.id]);
    expect(list.next_before).toBeNull();

    const detailRes = await request(`/api/bounties/${created.id}`);
    expect(detailRes.status).toBe(200);
    const text = await detailRes.text();
    expect(text).not.toContain("manage_token");
    expect(text).not.toContain(created.manage_token);
    expect(JSON.parse(text).bounty).toMatchObject({ id: created.id, status: "open", payment_tx: SETTLE_TX });
  });

  it("hides bounties whose payment has not settled", async () => {
    const { request } = makeApp();
    await env.DB.prepare(
      `INSERT INTO bounties (id, status, question, reward_usd, reward_units, network, asset, source, manage_token_hash, created_at, expires_at, updated_at)
       VALUES ('bty_pending', 'pending_payment', 'question text', '0.10', '1', 'eip155:2368', '0x0', 'agent', 'h', 1, 2, 1)`,
    ).run();
    expect((await request("/api/bounties/bty_pending")).status).toBe(404);
    expect(((await (await request("/api/bounties")).json()) as { bounties: unknown[] }).bounties).toHaveLength(0);
  });

  it.each([["/api/bounties?status=pending_payment"], ["/api/bounties?limit=0"], ["/api/bounties?limit=101"], ["/api/bounties?before=yesterday"]])(
    "rejects bad query %s",
    async (path) => {
      const { request } = makeApp();
      expect((await request(path)).status).toBe(400);
    },
  );

  it("returns JSON 404 for unknown routes", async () => {
    const { request } = makeApp();
    const res = await request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { unitsToDecimal } from "../src/money.js";
import { ANSWER_LIMITS, RATE_HIT_RETENTION_SECONDS } from "../src/ratelimit.js";
import { escrowLedger } from "../src/ledger.js";
import { FakeChain } from "./fake-chain.js";
import { FakeEscrow, makeApp, paymentHeaderFor, postJson } from "./helpers.js";

const TENTH = 100_000_000_000_000_000n; // 0.10 pieUSD
const TTL = 3600;

type App = ReturnType<typeof makeApp>;

async function postBounty(app: App, extra: Record<string, unknown> = {}) {
  const body = { question: "Does example.com load on a phone in Brazil?", reward_usd: "0.10", ttl_seconds: TTL, ...extra };
  const challenge = await app.request("/v1/bounties", postJson(body));
  const res = await app.request("/v1/bounties", postJson(body, { "PAYMENT-SIGNATURE": paymentHeaderFor(challenge.headers.get("PAYMENT-REQUIRED")!) }));
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; manage_token: string };
}

/** Distinct, valid, lowercase test addresses. */
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

function answer(app: App, id: string, payout_address: string, ip?: string) {
  return app.request(`/api/bounties/${id}/answers`, postJson({ answer: "Yes, it loads.", payout_address }, ip ? { "CF-Connecting-IP": ip } : {}));
}

async function answerId(app: App, id: string, payout_address: string) {
  const res = await answer(app, id, payout_address);
  expect(res.status).toBe(201);
  return ((await res.json()) as { answer: { id: string } }).answer.id;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function stats(app: App) {
  const res = await app.request("/api/stats");
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

describe("GET /api/stats", () => {
  it("reports zeros and a balanced escrow when nothing was posted", async () => {
    const body = await stats(makeApp());
    expect(body).toMatchObject({
      network: "eip155:2368",
      escrow_address: "0x7ec512bAcF9F3a1EC024F9bC5AbFDA3836ADDEa9",
      bounties: { total: 0, by_source: { agent: 0, manual: 0 }, accepted: 0, refunded: 0 },
      answers: { total: 0, distinct_answerers: 0 },
      distinct_payers: 0,
      median_seconds_to_first_answer: null,
      escrow: { status: "ok", held: { units: "0", usd: "0" }, wallet_balance: { units: "0", usd: "0" }, gas_low: false },
    });
  });

  it("follows the money through a payout, a refund and an open bounty", async () => {
    const app = makeApp();
    const paid = await postBounty(app);
    const refunded = await postBounty(app, { source: "manual" });
    await postBounty(app);

    const ans = await answerId(app, paid.id, address(1));
    expect((await app.request(`/api/bounties/${paid.id}/accept`, postJson({ answer_id: ans }, auth(paid.manage_token)))).status).toBe(200);
    expect((await app.request(`/api/bounties/${refunded.id}/cancel`, { method: "POST", headers: auth(refunded.manage_token) })).status).toBe(200);
    expect(app.chain!.paid().map((t) => t.amount)).toEqual([TENTH, TENTH]);

    // What the wallet holds after receiving 0.3 and sending 0.2.
    app.escrow!.token = TENTH;
    const body = await stats(app);
    expect(body.bounties).toMatchObject({ total: 3, by_source: { agent: 2, manual: 1 }, accepted: 1, refunded: 1 });
    expect(body.bounties.by_status).toMatchObject({ open: 1, paid: 1, refunded: 1, answered: 0 });
    expect(body.answers).toEqual({ total: 1, distinct_answerers: 1 });
    expect(body.distinct_payers).toBe(1);
    expect(body.escrow).toMatchObject({
      status: "ok",
      received: { usd: "0.3" },
      paid_out: { usd: "0.1" },
      refunded: { usd: "0.1" },
      held: { units: TENTH.toString(), usd: "0.1" },
      in_flight: { usd: "0" },
      wallet_balance: { usd: "0.1" },
    });

    app.escrow!.token = TENTH - 1n;
    expect((await stats(app)).escrow.status).toBe("short");
  });

  it("calls a gap covered by a signed, unrecorded payout settling, not short", async () => {
    const chain = new FakeChain();
    chain.mineOnBroadcast = false; // the payout stays in the mempool
    const app = makeApp({ chain });
    const { id, manage_token } = await postBounty(app);
    const ans = await answerId(app, id, address(1));
    await app.request(`/api/bounties/${id}/accept`, postJson({ answer_id: ans }, auth(manage_token)));

    // The transfer may already have left the wallet while the bounty is still accepting.
    app.escrow!.token = 0n;
    const body = await stats(app);
    expect(body.bounties.by_status.accepting).toBe(1);
    expect(body.escrow).toMatchObject({ status: "settling", held: { usd: "0.1" }, in_flight: { usd: "0.1" } });
  });

  it("does not count bounties whose payment never settled", async () => {
    const app = makeApp();
    app.facilitator.settleResult = { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:2368" };
    const body = { question: "Does example.com load on a phone in Brazil?", reward_usd: "0.10", ttl_seconds: TTL };
    const challenge = await app.request("/v1/bounties", postJson(body));
    await app.request("/v1/bounties", postJson(body, { "PAYMENT-SIGNATURE": paymentHeaderFor(challenge.headers.get("PAYMENT-REQUIRED")!) }));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM bounties").first<{ n: number }>())!.n).toBe(1);

    const stats_ = await stats(app);
    expect(stats_.bounties.total).toBe(0);
    expect(stats_.escrow.received.units).toBe("0");
  });

  it("reports unknown when the wallet cannot be read, and flags low gas", async () => {
    const escrow = new FakeEscrow();
    escrow.token = new Error("rpc down");
    escrow.gas = 10n ** 15n; // 0.001 KITE
    const body = await stats(makeApp({ escrow }));
    expect(body.escrow).toMatchObject({ status: "unknown", wallet_balance: null, gas_balance_wei: "1000000000000000", gas_low: true });

    const none = await stats(makeApp({ escrow: null }));
    expect(none.escrow).toMatchObject({ status: "unknown", wallet_balance: null, gas_balance_wei: null, gas_low: null });
  });

  it("gives the median time from posting to the first answer", async () => {
    const app = makeApp();
    const a = await postBounty(app);
    const b = await postBounty(app);
    app.clock.now += 60;
    await answerId(app, a.id, address(1));
    app.clock.now += 60;
    await answerId(app, b.id, address(2));
    await answerId(app, a.id, address(3)); // a later answer does not change the first-answer time
    const body = await stats(app);
    expect(body.median_seconds_to_first_answer).toBe(90);
    expect(body.answers).toEqual({ total: 3, distinct_answerers: 3 });
  });

  it("sums amounts exactly past the SQLite integer range", async () => {
    // 3 x 5 pieUSD = 1.5e19 base units, above 2^63 - 1 (about 9.22e18).
    const five = 5n * 10n ** 18n;
    for (const id of ["bty_a", "bty_b", "bty_c"]) {
      await env.DB.prepare(
        `INSERT INTO bounties (id, status, question, reward_usd, reward_units, network, asset, source, manage_token_hash, payer, payment_tx, created_at, expires_at, updated_at)
         VALUES (?, 'open', 'q', '5', ?, 'eip155:2368', '0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A', 'agent', 'h', '0x1', '0x2', 1, 2, 1)`,
      )
        .bind(id, five.toString())
        .run();
    }
    const ledger = await escrowLedger(env.DB);
    expect(ledger.held).toBe(3n * five);
    expect(ledger.received).toBe(15_000_000_000_000_000_000n);
  });
});

describe("cron escrow check", () => {
  it("records the escrow status and the gas warning on every run", async () => {
    const app = makeApp();
    await postBounty(app);
    app.escrow!.token = TENTH;
    expect(await app.runSweep()).toMatchObject({ escrow: "ok", gasLow: false });

    app.escrow!.token = 0n;
    app.escrow!.gas = 0n;
    expect(await app.runSweep()).toMatchObject({ escrow: "short", gasLow: true });
  });
});

describe("answer rate limits", () => {
  it(`allows ${ANSWER_LIMITS.ip.max} answers per IP per window, then 429 with Retry-After`, async () => {
    const app = makeApp();
    const { id } = await postBounty(app);
    for (let i = 1; i <= ANSWER_LIMITS.ip.max; i++) expect((await answer(app, id, address(i), "203.0.113.7")).status).toBe(201);

    const limited = await answer(app, id, address(100), "203.0.113.7");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe(String(ANSWER_LIMITS.ip.windowSeconds));
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("rate_limited");

    // Another IP is not affected, and the first IP may answer again once the window passes.
    expect((await answer(app, id, address(101), "198.51.100.1")).status).toBe(201);
    app.clock.now += ANSWER_LIMITS.ip.windowSeconds;
    expect((await answer(app, id, address(102), "203.0.113.7")).status).toBe(201);
  });

  it(`allows ${ANSWER_LIMITS.address.max} answers per payout address per hour across bounties`, async () => {
    const app = makeApp();
    const ids: string[] = [];
    for (let i = 0; i <= ANSWER_LIMITS.address.max; i++) ids.push((await postBounty(app)).id);
    const A = address(0xabcdef);
    for (let i = 0; i < ANSWER_LIMITS.address.max; i++) expect((await answer(app, ids[i], A)).status).toBe(201);
    const limited = await answer(app, ids[ANSWER_LIMITS.address.max], A);
    expect(limited.status).toBe(429);
    // The same address in upper case is the same key.
    expect((await answer(app, ids[ANSWER_LIMITS.address.max], `0x${A.slice(2).toUpperCase()}`)).status).toBe(429);
  });

  it("counts only accepted answers", async () => {
    const app = makeApp();
    const { id } = await postBounty(app);
    expect((await answer(app, id, address(1), "203.0.113.7")).status).toBe(201);
    for (let i = 0; i < ANSWER_LIMITS.ip.max + 5; i++) {
      expect((await answer(app, id, address(1), "203.0.113.7")).status).toBe(409); // duplicate
      expect((await app.request(`/api/bounties/${id}/answers`, postJson({ answer: "", payout_address: address(2) }, { "CF-Connecting-IP": "203.0.113.7" }))).status).toBe(400);
    }
    expect((await answer(app, id, address(3), "203.0.113.7")).status).toBe(201);
  });

  it("stores hashes, not IPs or addresses, and the cron job prunes old hits", async () => {
    const app = makeApp();
    const { id } = await postBounty(app);
    await answer(app, id, address(1), "203.0.113.7");
    const { results } = await env.DB.prepare("SELECT bucket, key FROM rate_hits ORDER BY bucket").all<{ bucket: string; key: string }>();
    expect(results.map((r) => r.bucket)).toEqual(["answer_address", "answer_ip"]);
    for (const r of results) {
      expect(r.key).toMatch(/^[0-9a-f]{64}$/);
      expect(r.key).not.toContain("203.0.113.7");
    }

    app.clock.now += RATE_HIT_RETENTION_SECONDS;
    expect((await app.runSweep()).prunedRateHits).toBe(2);
  });
});

describe("unitsToDecimal", () => {
  it.each([
    [0n, 18, "0"],
    [TENTH, 18, "0.1"],
    [1n, 18, "0.000000000000000001"],
    [15_000_000_000_000_000_000n, 18, "15"],
    [1_234_500n, 6, "1.2345"],
    [-TENTH, 18, "-0.1"],
    [42n, 0, "42"],
  ])("%s with %s decimals is %s", (units, decimals, expected) => {
    expect(unitsToDecimal(units, decimals)).toBe(expected);
  });
});

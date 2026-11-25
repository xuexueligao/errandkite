import { env } from "cloudflare:test";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { MAX_ANSWERS_PER_BOUNTY } from "../src/db.js";
import { MAX_TRANSFER_ATTEMPTS } from "../src/transfers.js";
import { FakeChain } from "./fake-chain.js";
import { makeApp, PAYER, paymentHeaderFor, postJson } from "./helpers.js";

const PAY_TO = "0x7ec512bAcF9F3a1EC024F9bC5AbFDA3836ADDEa9";
const ALICE = "0xA11ce00000000000000000000000000000000001".toLowerCase();
const BOB = "0x0000000000000000000000000000000000000b0b";
const REWARD_UNITS = 100_000_000_000_000_000n; // 0.10 pieUSD
const TTL = 3600;

type App = ReturnType<typeof makeApp>;

async function postBounty(app: App, ttl = TTL) {
  const body = { question: "Does example.com load on a phone in Brazil?", reward_usd: "0.10", ttl_seconds: ttl };
  const challenge = await app.request("/v1/bounties", postJson(body));
  const res = await app.request("/v1/bounties", postJson(body, { "PAYMENT-SIGNATURE": paymentHeaderFor(challenge.headers.get("PAYMENT-REQUIRED")!) }));
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; manage_token: string };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function answer(app: App, id: string, payout_address: string, text = "Yes, it loads in about 2 seconds.") {
  return app.request(`/api/bounties/${id}/answers`, postJson({ answer: text, payout_address }));
}

async function answerId(app: App, id: string, address: string) {
  const res = await answer(app, id, address);
  expect(res.status).toBe(201);
  return ((await res.json()) as { answer: { id: string } }).answer.id;
}

async function accept(app: App, id: string, token: string, answer_id: string) {
  return app.request(`/api/bounties/${id}/accept`, postJson({ answer_id }, auth(token)));
}

async function publicBounty(app: App, id: string) {
  return ((await (await app.request(`/api/bounties/${id}`)).json()) as { bounty: Record<string, unknown> }).bounty;
}

async function dbRow(id: string) {
  return (await env.DB.prepare("SELECT * FROM bounties WHERE id = ?").bind(id).first<Record<string, unknown>>())!;
}

describe("answering", () => {
  it("takes an answer with a payout address and moves the bounty to answered", async () => {
    const app = makeApp();
    const { id } = await postBounty(app);
    const res = await answer(app, id, ALICE);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { answer: { id: string; payout_address: string } };
    expect(body.answer.id).toMatch(/^ans_[0-9a-f]{32}$/);
    expect(body.answer.payout_address).toBe(getAddress(ALICE)); // stored checksummed
    const bounty = await publicBounty(app, id);
    expect(bounty).toMatchObject({ status: "answered", answer_count: 1, payout_tx: null, refund_tx: null });
    // Answer texts are only for the poster.
    expect(JSON.stringify(bounty)).not.toContain("2 seconds");
  });

  it.each([
    ["empty answer", { answer: "   ", payout_address: BOB }, "answer"],
    ["answer too long", { answer: "x".repeat(2001), payout_address: BOB }, "answer"],
    ["missing address", { answer: "ok" }, "payout_address"],
    ["bad checksum", { answer: "ok", payout_address: "0x0000000000000000000000000000000000000b0B" }, "payout_address"],
    ["zero address", { answer: "ok", payout_address: "0x0000000000000000000000000000000000000000" }, "payout_address"],
    ["platform wallet", { answer: "ok", payout_address: PAY_TO }, "payout_address"],
  ])("rejects %s with 400", async (_name, body, field) => {
    const app = makeApp();
    const { id } = await postBounty(app);
    const res = await app.request(`/api/bounties/${id}/answers`, postJson(body));
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { details: { field: string }[] } };
    expect(err.error.details.map((d) => d.field)).toContain(field);
  });

  it("allows one answer per address, whatever the letter case", async () => {
    const app = makeApp();
    const { id } = await postBounty(app);
    expect((await answer(app, id, ALICE)).status).toBe(201);
    const again = await answer(app, id, ALICE.toUpperCase().replace("0X", "0x"));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "duplicate_answer" } });
  });

  it(`caps a bounty at ${MAX_ANSWERS_PER_BOUNTY} answers`, async () => {
    const app = makeApp();
    const { id } = await postBounty(app);
    for (let i = 1; i <= MAX_ANSWERS_PER_BOUNTY; i++) {
      expect((await answer(app, id, `0x${i.toString(16).padStart(40, "0")}`)).status).toBe(201);
    }
    const res = await answer(app, id, BOB.replace("b0b", "fff"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "too_many_answers" } });
  });

  it("refuses answers after the bounty expires, even before the cron job runs", async () => {
    const app = makeApp();
    const { id } = await postBounty(app);
    app.clock.now += TTL;
    const res = await answer(app, id, ALICE);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "bounty_closed" } });
  });

  it("returns 404 for a bounty that does not exist", async () => {
    const app = makeApp();
    expect((await answer(app, "bty_missing", ALICE)).status).toBe(404);
  });
});

describe("manage token", () => {
  it("is required to read answers, accept and cancel", async () => {
    const app = makeApp();
    const mine = await postBounty(app);
    const other = await postBounty(app);
    const ans = await answerId(app, mine.id, ALICE);

    for (const [path, init] of [
      [`/api/bounties/${mine.id}/answers`, { method: "GET" }],
      [`/api/bounties/${mine.id}/accept`, postJson({ answer_id: ans })],
      [`/api/bounties/${mine.id}/cancel`, postJson({})],
    ] as const) {
      const none = await app.request(path, init);
      expect(none.status, `${path} without token`).toBe(401);
      const wrong = await app.request(path, { ...init, headers: { ...(init.headers ?? {}), ...auth(other.manage_token) } });
      expect(wrong.status, `${path} with another bounty's token`).toBe(403);
    }
    expect(app.chain!.signed).toHaveLength(0);

    const res = await app.request(`/api/bounties/${mine.id}/answers`, { headers: auth(mine.manage_token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      bounty_status: "answered",
      answers: [{ id: ans, answer: "Yes, it loads in about 2 seconds.", accepted: false }],
    });
  });
});

describe("accepting an answer", () => {
  it("pays the reward to the answer's address and records the payout transaction", async () => {
    const app = makeApp();
    const { id, manage_token } = await postBounty(app);
    await answerId(app, id, BOB);
    const ans = await answerId(app, id, ALICE);

    const res = await accept(app, id, manage_token, ans);
    expect(res.status).toBe(200);
    const { bounty } = (await res.json()) as { bounty: Record<string, unknown> };
    expect(bounty).toMatchObject({ status: "paid", accepted_answer_id: ans, transfer_error: null });

    const paid = app.chain!.paid();
    expect(paid).toHaveLength(1);
    expect(paid[0].to.toLowerCase()).toBe(ALICE);
    expect(paid[0].amount).toBe(REWARD_UNITS);
    expect(await publicBounty(app, id)).toMatchObject({ status: "paid", payout_tx: paid[0].hash, refund_tx: null });
    expect((await dbRow(id)).transfer_raw).toBeNull();
  });

  it("pays once when the same bounty is accepted many times at the same moment", async () => {
    const app = makeApp();
    const { id, manage_token } = await postBounty(app);
    const a = await answerId(app, id, ALICE);
    const b = await answerId(app, id, BOB);

    const results = await Promise.all([a, b, a, b, a, b].map((ans) => accept(app, id, manage_token, ans)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(app.chain!.signed).toHaveLength(1);
    expect(app.chain!.paid()).toHaveLength(1);
  });

  it("cannot accept an answer from another bounty", async () => {
    const app = makeApp();
    const mine = await postBounty(app);
    const other = await postBounty(app);
    await answerId(app, mine.id, BOB);
    const foreign = await answerId(app, other.id, ALICE);
    expect((await accept(app, mine.id, mine.manage_token, foreign)).status).toBe(404);
    expect(app.chain!.signed).toHaveLength(0);
  });

  it("refuses to accept after the bounty expired, and the cron job refunds it instead", async () => {
    const app = makeApp();
    const { id, manage_token } = await postBounty(app);
    const ans = await answerId(app, id, ALICE);
    app.clock.now += TTL;

    const res = await accept(app, id, manage_token, ans);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "bounty_expired" } });

    await app.runSweep();
    const paid = app.chain!.paid();
    expect(paid).toHaveLength(1);
    expect(paid[0].to).toBe(PAYER);
    expect(await publicBounty(app, id)).toMatchObject({ status: "refunded", refund_tx: paid[0].hash, payout_tx: null });
  });

  it("keeps the bounty in accepting with an error when payouts are not configured", async () => {
    const app = makeApp({ chain: null });
    const { id, manage_token } = await postBounty(app);
    const ans = await answerId(app, id, ALICE);
    const { bounty } = (await (await accept(app, id, manage_token, ans)).json()) as { bounty: Record<string, unknown> };
    expect(bounty.status).toBe("accepting");
    expect(String(bounty.transfer_error)).toContain("PLATFORM_PRIVATE_KEY");
  });
});

describe("payouts survive failures without paying twice", () => {
  async function acceptedBounty(app: App) {
    const { id, manage_token } = await postBounty(app);
    const ans = await answerId(app, id, ALICE);
    return { id, res: await accept(app, id, manage_token, ans) };
  }

  it("node accepted the transaction but the call failed: the cron job confirms it, no second transfer", async () => {
    const chain = new FakeChain();
    chain.failBroadcast = 1;
    const app = makeApp({ chain });
    const { id, res } = await acceptedBounty(app);
    expect(((await res.json()) as { bounty: { status: string } }).bounty.status).toBe("accepting");

    await app.runSweep();
    expect((await dbRow(id)).status).toBe("paid");
    expect(chain.signed).toHaveLength(1);
    expect(chain.paid()).toHaveLength(1);
  });

  it("node never saw the transaction: the cron job re-sends the same signed bytes", async () => {
    const chain = new FakeChain();
    chain.dropBroadcast = 1;
    const app = makeApp({ chain });
    const { id } = await acceptedBounty(app);
    const before = await dbRow(id);
    expect(before.status).toBe("accepting");
    expect(before.transfer_tx).toBe(chain.signed[0].hash);

    await app.runSweep();
    expect((await dbRow(id)).status).toBe("paid");
    expect(chain.signed).toHaveLength(1);
    expect(chain.broadcasts).toBe(2);
    expect(chain.paid()).toHaveLength(1);
  });

  it("nonce taken by another payout: the dead transaction is dropped and a new one is signed", async () => {
    const chain = new FakeChain();
    const app = makeApp({ chain });
    chain.dropBroadcast = 1; // A's transaction never reaches the node...
    const a = await acceptedBounty(app);
    const b = await acceptedBounty(app); // ...so B signs the same nonce and is mined.
    expect(chain.signed[0].nonce).toBe(chain.signed[1].nonce);
    expect((await dbRow(b.id)).status).toBe("paid");

    await app.runSweep();
    expect((await dbRow(a.id)).status).toBe("paid");
    expect(chain.signed).toHaveLength(3);
    expect(chain.paid()).toHaveLength(2); // one per bounty
  });

  it("a reverted transfer is retried with a new transaction", async () => {
    const chain = new FakeChain();
    chain.revertNext = 1;
    const app = makeApp({ chain });
    const { id } = await acceptedBounty(app);
    const row = await dbRow(id);
    expect(row.status).toBe("accepting");
    expect(String(row.transfer_error)).toContain("reverted");

    await app.runSweep();
    expect((await dbRow(id)).status).toBe("paid");
    expect(chain.paid()).toHaveLength(1);
  });

  it("an empty wallet (signing fails) leaves nothing on chain until it is fixed", async () => {
    const chain = new FakeChain();
    chain.failSign = new Error("insufficient funds for gas");
    const app = makeApp({ chain });
    const { id } = await acceptedBounty(app);
    expect(String((await dbRow(id)).transfer_error)).toContain("insufficient funds");
    expect(chain.signed).toHaveLength(0);

    chain.failSign = null;
    await app.runSweep();
    expect((await dbRow(id)).status).toBe("paid");
  });

  it(`gives up after ${MAX_TRANSFER_ATTEMPTS} failed transactions and waits for an operator`, async () => {
    const chain = new FakeChain();
    chain.revertNext = 100;
    const app = makeApp({ chain });
    const { id } = await acceptedBounty(app);
    for (let i = 0; i < MAX_TRANSFER_ATTEMPTS + 3; i++) await app.runSweep();
    const row = await dbRow(id);
    expect(row.status).toBe("accepting");
    expect(row.transfer_attempts).toBe(MAX_TRANSFER_ATTEMPTS);
    expect(String(row.transfer_error)).toContain("operator");
    expect(chain.signed).toHaveLength(MAX_TRANSFER_ATTEMPTS);
    expect(chain.paid()).toHaveLength(0);
  });
});

describe("refunds", () => {
  it("refunds an expired bounty nobody answered to the payer", async () => {
    const app = makeApp();
    const { id } = await postBounty(app);
    await app.runSweep();
    expect((await dbRow(id)).status).toBe("open"); // not expired yet

    app.clock.now += TTL;
    const report = await app.runSweep();
    expect(report.expired).toBe(1);
    const paid = app.chain!.paid();
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ to: PAYER, amount: REWARD_UNITS });
    expect(await publicBounty(app, id)).toMatchObject({ status: "refunded", refund_tx: paid[0].hash });
  });

  it("refunds an answered bounty whose poster never accepted, and pays no answerer", async () => {
    const app = makeApp();
    const { id } = await postBounty(app);
    await answerId(app, id, ALICE);
    app.clock.now += TTL;
    await app.runSweep();
    expect((await dbRow(id)).status).toBe("refunded");
    expect(app.chain!.paid().map((t) => t.to)).toEqual([PAYER]);
  });

  it("lets the poster cancel an open bounty with no answers, and refunds it", async () => {
    const app = makeApp();
    const { id, manage_token } = await postBounty(app);
    const res = await app.request(`/api/bounties/${id}/cancel`, postJson({}, auth(manage_token)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ bounty: { status: "refunded" } });
    expect(app.chain!.paid().map((t) => t.to)).toEqual([PAYER]);
  });

  it("does not let the poster cancel once someone answered", async () => {
    const app = makeApp();
    const { id, manage_token } = await postBounty(app);
    await answerId(app, id, ALICE);
    const res = await app.request(`/api/bounties/${id}/cancel`, postJson({}, auth(manage_token)));
    expect(res.status).toBe(409);
    expect(app.chain!.signed).toHaveLength(0);
  });

  it("leaves paid bounties alone", async () => {
    const app = makeApp();
    const { id, manage_token } = await postBounty(app);
    await accept(app, id, manage_token, await answerId(app, id, ALICE));
    app.clock.now += TTL * 10;
    const report = await app.runSweep();
    expect(report.expired).toBe(0);
    expect((await dbRow(id)).status).toBe("paid");
    expect(app.chain!.paid()).toHaveLength(1);
  });
});

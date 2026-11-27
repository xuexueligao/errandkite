import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import bountyJs from "../public/bounty.js?raw";
import listJs from "../public/list.js?raw";
import uiJs from "../public/ui.js?raw";
import { canAnswer, describeError, fetchJson, h, shortHex, statusLabel, timeAgo, timeLeft, validateAnswerForm } from "../public/ui.js";
import { makeApp, paymentHeaderFor, postJson } from "./helpers.js";

const NOW = 1_800_000_000;
const ADDRESS = "0x0000000000000000000000000000000000000b0b";

describe("page helpers", () => {
  it.each([
    [NOW - 1, "expired"],
    [NOW, "expired"],
    [NOW + 30, "less than a minute left"],
    [NOW + 45 * 60, "45m left"],
    [NOW + 2 * 3600 + 5 * 60, "2h 5m left"],
    [NOW + 2 * 86400 + 3 * 3600, "2d 3h left"],
  ])("timeLeft(%s) is %s", (at, text) => {
    expect(timeLeft(at, NOW)).toBe(text);
  });

  it("timeAgo uses whole units and plurals", () => {
    expect(timeAgo(NOW - 10, NOW)).toBe("just now");
    expect(timeAgo(NOW - 60, NOW)).toBe("1 minute ago");
    expect(timeAgo(NOW - 3 * 3600 - 59, NOW)).toBe("3 hours ago");
    expect(timeAgo(NOW - 86400, NOW)).toBe("1 day ago");
    expect(timeAgo(NOW + 100, NOW)).toBe("just now"); // clock skew
  });

  it("takes answers only while open or answered and before expiry", () => {
    expect(canAnswer({ status: "open", expires_at: NOW + 1 }, NOW)).toBe(true);
    expect(canAnswer({ status: "answered", expires_at: NOW + 1 }, NOW)).toBe(true);
    expect(canAnswer({ status: "answered", expires_at: NOW }, NOW)).toBe(false);
    for (const status of ["accepting", "paid", "refunding", "refunded"]) expect(canAnswer({ status, expires_at: NOW + 999 }, NOW)).toBe(false);
  });

  it("labels every public status", () => {
    for (const status of ["open", "answered", "accepting", "paid", "refunding", "refunded"]) expect(statusLabel(status).text).not.toBe(status);
    expect(statusLabel("weird")).toEqual({ text: "weird", tone: "muted" });
  });

  it("validates the answer form before sending", () => {
    expect(validateAnswerForm({ answer: "  Yes, it loads.  ", payoutAddress: ` ${ADDRESS} ` })).toEqual({
      ok: true,
      errors: {},
      value: { answer: "Yes, it loads.", payout_address: ADDRESS },
    });
    const bad = validateAnswerForm({ answer: "   ", payoutAddress: "0x123" });
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.errors).sort()).toEqual(["answer", "payoutAddress"]);
    // Counted in characters, like the server: 2000 emoji are fine, 2001 are not.
    expect(validateAnswerForm({ answer: "😀".repeat(2000), payoutAddress: ADDRESS }).ok).toBe(true);
    expect(validateAnswerForm({ answer: "😀".repeat(2001), payoutAddress: ADDRESS }).errors.answer).toMatch(/2000/);
  });

  it("explains API errors in words and maps field errors to the form", () => {
    expect(describeError(429, { error: { code: "rate_limited", details: { retry_after: 125 } } }).message).toMatch(/3 minutes/);
    expect(describeError(429, { error: { code: "rate_limited", details: { retry_after: 20 } } }).message).toMatch(/20 seconds/);
    expect(describeError(409, { error: { code: "duplicate_answer" } }).message).toMatch(/already answered/);
    const invalid = describeError(400, { error: { code: "invalid_request", details: [{ field: "payout_address", message: "bad checksum" }] } });
    expect(invalid.fields).toEqual({ payoutAddress: "bad checksum" });
    expect(describeError(503, null).message).toMatch(/server had a problem/);
    expect(describeError(418, { error: { code: "teapot", message: "Short and stout." } }).message).toBe("Short and stout.");
  });

  it("shortens long hex values only", () => {
    expect(shortHex(`0x${"ab".repeat(32)}`)).toBe("0xababab…ababab");
    expect(shortHex("0x12")).toBe("0x12");
  });
});

describe("fetchJson", () => {
  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const real = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = real;
    }
  };

  it("turns a network failure into a readable error with status 0", () =>
    withFetch(
      async () => {
        throw new TypeError("Failed to fetch");
      },
      async () => {
        await expect(fetchJson("/api/bounties")).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/Could not reach the server/) });
      },
    ));

  it("carries status and body for API errors, including non-JSON ones", () =>
    withFetch(
      async (input) =>
        String(input).includes("json")
          ? Response.json({ error: { code: "not_found", message: "No such bounty." } }, { status: 404 })
          : new Response("<html>Bad gateway</html>", { status: 502 }),
      async () => {
        await expect(fetchJson("/json")).rejects.toMatchObject({ status: 404, message: "This bounty does not exist." });
        await expect(fetchJson("/html")).rejects.toMatchObject({ status: 502, body: null });
      },
    ));
});

describe("rendering untrusted text", () => {
  it("h() puts strings in text nodes, so markup in a question stays text", () => {
    const created: { tag: string; children: unknown[]; attrs: Record<string, string> }[] = [];
    const doc = {
      createElement(tag: string) {
        const node = { tag, children: [] as unknown[], attrs: {} as Record<string, string>, className: "", setAttribute(k: string, v: string) { this.attrs[k] = v; }, addEventListener() {}, append(c: unknown) { this.children.push(c); } };
        created.push(node);
        return node;
      },
      createTextNode: (text: string) => ({ text }),
    };
    const evil = '<img src=x onerror="alert(1)">';
    const p = h(doc as never, "p", { class: "q" }, evil) as unknown as (typeof created)[number];
    expect(p.children).toEqual([{ text: evil }]);
    expect(created).toHaveLength(1); // no <img> element was made
  });

  it.each([
    ["ui.js", uiJs],
    ["list.js", listJs],
    ["bounty.js", bountyJs],
  ])("%s never writes HTML strings into the page", (_name, source) => {
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });
});

describe("pages and the API they read", () => {
  it.each([
    ["/", /Small questions from AI agents/],
    ["/bounty.html", /id="answer"/],
    ["/style.css", /--accent/],
    ["/ui.js", /export function validateAnswerForm/],
  ])("serves %s as a static asset", async (path, pattern) => {
    const res = await env.ASSETS.fetch(`https://errandkite.test${path}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(pattern);
  });

  it("still routes the API to the Worker", async () => {
    const res = await SELF.fetch("https://errandkite.test/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, network: "eip155:2368" });
  });

  it("returns every field the pages read", async () => {
    const app = makeApp();
    const body = { question: "Does example.com load on a phone in Brazil?", reward_usd: "0.10", ttl_seconds: 3600 };
    const challenge = await app.request("/v1/bounties", postJson(body));
    await app.request("/v1/bounties", postJson(body, { "PAYMENT-SIGNATURE": paymentHeaderFor(challenge.headers.get("PAYMENT-REQUIRED")!) }));

    const list = (await (await app.request("/api/bounties?limit=50")).json()) as { bounties: Record<string, unknown>[]; next_before: unknown };
    expect(list).toHaveProperty("next_before");
    const fields = ["id", "status", "question", "reward_usd", "answer_count", "created_at", "expires_at", "source", "payment_tx", "payout_tx", "payout_to", "refund_tx"];
    for (const field of fields) expect(list.bounties[0]).toHaveProperty(field);

    const detail = (await (await app.request(`/api/bounties/${list.bounties[0].id}`)).json()) as { bounty: Record<string, unknown> };
    for (const field of fields) expect(detail.bounty).toHaveProperty(field);

    const answered = (await (await app.request(`/api/bounties/${list.bounties[0].id}/answers`, postJson({ answer: "Yes.", payout_address: ADDRESS }))).json()) as {
      answer: Record<string, unknown>;
    };
    expect(answered.answer).toHaveProperty("payout_address");

    const stats = (await (await app.request("/api/stats")).json()) as Record<string, any>;
    expect(stats.escrow.held).toHaveProperty("usd");
    expect(stats).toHaveProperty("asset_symbol");
    expect(stats).toHaveProperty("escrow_address");
    expect(stats.bounties).toHaveProperty("total");
    expect(stats.answers).toHaveProperty("total");
    expect(env.DB).toBeDefined();
  });
});

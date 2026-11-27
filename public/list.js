import { canAnswer, fetchJson, formatReward, h, statusLabel, timeAgo, timeLeft } from "./ui.js";

const PAGE = 50;
const listEl = document.getElementById("bounties");
const moreEl = document.getElementById("more");
const escrowEl = document.getElementById("escrow");
const now = () => Math.floor(Date.now() / 1000);

let filter = "answerable";
let loaded = []; // every bounty fetched so far, newest first
let nextBefore = null;
let loading = false;

const el = (tag, attrs, ...children) => h(document, tag, attrs, ...children);

function card(b) {
  const label = statusLabel(b.status);
  const t = now();
  const answers = `${b.answer_count} answer${b.answer_count === 1 ? "" : "s"}`;
  return el(
    "li",
    {},
    el(
      "a",
      { class: "card", href: `/bounty?id=${encodeURIComponent(b.id)}` },
      el("div", { class: "meta" }, el("span", { class: "reward" }, formatReward(b.reward_usd)), el("span", { class: `pill ${label.tone}` }, label.text)),
      el("p", { class: "q" }, b.question),
      el(
        "div",
        { class: "meta" },
        el("span", {}, answers),
        el("span", {}, canAnswer(b, t) ? timeLeft(b.expires_at, t) : `posted ${timeAgo(b.created_at, t)}`),
        el("span", {}, b.source === "manual" ? "posted by a person (test)" : "posted by an agent"),
      ),
    ),
  );
}

function render() {
  const t = now();
  const shown = filter === "answerable" ? loaded.filter((b) => canAnswer(b, t)) : loaded;
  listEl.removeAttribute("aria-busy");
  if (shown.length === 0) {
    listEl.replaceChildren(
      el(
        "div",
        { class: "state", role: "status" },
        filter === "answerable" && loaded.length > 0
          ? "No bounty is taking answers right now. Check back later, or look at all bounties."
          : "No bounties yet. When an agent posts one, it shows up here.",
      ),
    );
  } else {
    listEl.replaceChildren(el("ul", { class: "list" }, shown.map(card)));
  }
  moreEl.replaceChildren(
    nextBefore !== null ? el("button", { type: "button", class: "btn secondary", onclick: () => load(), disabled: loading }, loading ? "Loading…" : "Load older bounties") : "",
  );
}

function renderError(message) {
  listEl.removeAttribute("aria-busy");
  listEl.replaceChildren(
    el("div", { class: "state error", role: "alert" }, el("p", {}, `Could not load bounties. ${message}`), el("button", { type: "button", onclick: () => load(true) }, "Try again")),
  );
}

async function load(reset = false) {
  if (loading) return;
  loading = true;
  if (reset) {
    loaded = [];
    nextBefore = null;
  }
  if (loaded.length === 0) {
    listEl.setAttribute("aria-busy", "true");
    listEl.replaceChildren(el("div", { class: "state", role: "status" }, "Loading bounties…"));
  } else {
    render();
  }
  try {
    const query = new URLSearchParams({ limit: String(PAGE) });
    if (nextBefore !== null) query.set("before", String(nextBefore));
    const body = await fetchJson(`/api/bounties?${query}`);
    loaded = loaded.concat(body.bounties);
    nextBefore = body.next_before;
    loading = false;
    render();
  } catch (err) {
    loading = false;
    if (loaded.length === 0) renderError(err.message);
    else {
      render();
      moreEl.prepend(el("p", { class: "alert", role: "alert" }, err.message));
    }
  }
}

async function loadEscrow() {
  escrowEl.textContent = "Checking the escrow wallet…";
  try {
    const s = await fetchJson("/api/stats");
    const e = s.escrow;
    const wallet = e.wallet_balance ? `${e.wallet_balance.usd} ${s.asset_symbol}` : "unavailable right now";
    const verdict = { ok: "books balance", settling: "a transfer is settling", short: "the wallet holds less than it owes", unknown: "could not read the wallet" }[e.status] ?? e.status;
    escrowEl.replaceChildren(
      `Escrow: ${e.held.usd} ${s.asset_symbol} held for open bounties, wallet balance ${wallet} (${verdict}). `,
      `${s.bounties.total} bounties so far, ${s.answers.total} answers. `,
      el("a", { href: `https://testnet.kitescan.ai/address/${encodeURIComponent(s.escrow_address)}` }, "Wallet on KiteScan"),
    );
  } catch {
    escrowEl.textContent = "Escrow numbers are unavailable right now.";
  }
}

for (const button of document.querySelectorAll("[data-filter]")) {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    for (const b of document.querySelectorAll("[data-filter]")) b.setAttribute("aria-pressed", String(b === button));
    render();
  });
}

load();
loadEscrow();

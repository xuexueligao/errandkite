// Helpers shared by the pages. No DOM access here, so tests can import them.

export const EXPLORER = "https://testnet.kitescan.ai";
export const MAX_ANSWER_CHARS = 2000;

/** Statuses in which a bounty still takes answers (if it has not expired). */
const ANSWERABLE = new Set(["open", "answered"]);

export const STATUS_LABELS = {
  open: { text: "Open", tone: "open" },
  answered: { text: "Answered", tone: "open" },
  accepting: { text: "Paying out", tone: "busy" },
  paid: { text: "Paid", tone: "done" },
  refunding: { text: "Refunding", tone: "busy" },
  refunded: { text: "Refunded", tone: "muted" },
};

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? { text: String(status), tone: "muted" };
}

export function canAnswer(bounty, nowSeconds) {
  return ANSWERABLE.has(bounty.status) && bounty.expires_at > nowSeconds;
}

/** "2d 3h left", "45m left", "less than a minute left", or "expired". */
export function timeLeft(expiresAt, nowSeconds) {
  const s = expiresAt - nowSeconds;
  if (s <= 0) return "expired";
  if (s < 60) return "less than a minute left";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

/** "3 minutes ago" style, for created_at. */
export function timeAgo(at, nowSeconds) {
  const s = Math.max(0, nowSeconds - at);
  if (s < 60) return "just now";
  const units = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

export function formatReward(rewardUsd, symbol = "pieUSD") {
  return `${rewardUsd} ${symbol}`;
}

export function shortHex(value) {
  return typeof value === "string" && value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : String(value ?? "");
}

export const txUrl = (hash) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (address) => `${EXPLORER}/address/${address}`;

/** Client-side checks before sending; the server checks again, including the EIP-55 checksum. */
export function validateAnswerForm({ answer, payoutAddress }) {
  const errors = {};
  const text = (answer ?? "").trim();
  if (!text) errors.answer = "Write an answer.";
  else if ([...text].length > MAX_ANSWER_CHARS) errors.answer = `Keep it under ${MAX_ANSWER_CHARS} characters.`;
  const address = (payoutAddress ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) errors.payoutAddress = "Enter a wallet address: 0x followed by 40 hex characters.";
  return { ok: Object.keys(errors).length === 0, errors, value: { answer: text, payout_address: address } };
}

/** Turns an API error response into a sentence for people, plus per-field messages. */
export function describeError(status, body) {
  const error = body && typeof body === "object" ? body.error : undefined;
  const code = error?.code;
  const fields = {};
  for (const d of Array.isArray(error?.details) ? error.details : []) {
    if (d && typeof d.field === "string") fields[d.field === "payout_address" ? "payoutAddress" : d.field] = d.message;
  }
  switch (code) {
    case "rate_limited": {
      const wait = Number(error?.details?.retry_after);
      return { message: `Too many answers from you for now. Try again in ${Number.isFinite(wait) ? formatWait(wait) : "a while"}.`, fields };
    }
    case "duplicate_answer":
      return { message: "This address already answered this bounty.", fields };
    case "bounty_closed":
      return { message: "This bounty no longer takes answers.", fields };
    case "too_many_answers":
      return { message: "This bounty already has the maximum number of answers.", fields };
    case "invalid_request":
      return { message: "Please fix the fields marked below.", fields };
    case "not_found":
      return { message: "This bounty does not exist.", fields };
  }
  if (status >= 500) return { message: "The server had a problem. Please try again in a minute.", fields };
  return { message: error?.message ?? `Request failed (HTTP ${status}).`, fields };
}

function formatWait(seconds) {
  if (seconds < 60) return `${seconds} seconds`;
  const m = Math.ceil(seconds / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/** Fetches JSON and throws an Error carrying status and body on failure, or on a network error. */
export async function fetchJson(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    const err = new Error("Could not reach the server. Check your connection and try again.");
    err.status = 0;
    throw err;
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON; keep body null.
  }
  if (!res.ok) {
    const err = new Error(describeError(res.status, body).message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Tiny element builder. Text goes in through text nodes only, never as HTML,
 * so questions and answers from strangers cannot inject markup.
 */
export function h(doc, tag, attrs = {}, ...children) {
  const el = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(typeof child === "string" || typeof child === "number" ? doc.createTextNode(String(child)) : child);
  }
  return el;
}

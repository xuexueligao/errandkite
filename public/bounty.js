import {
  addressUrl,
  canAnswer,
  describeError,
  fetchJson,
  formatReward,
  h,
  MAX_ANSWER_CHARS,
  shortHex,
  statusLabel,
  timeAgo,
  timeLeft,
  txUrl,
  validateAnswerForm,
} from "./ui.js";

const bountyEl = document.getElementById("bounty");
const answerEl = document.getElementById("answer");
const id = new URLSearchParams(location.search).get("id") ?? "";
const now = () => Math.floor(Date.now() / 1000);
const el = (tag, attrs, ...children) => h(document, tag, attrs, ...children);

const txLink = (hash) => el("a", { class: "mono", href: txUrl(hash), rel: "noopener" }, shortHex(hash));
const addressLink = (address) => el("a", { class: "mono", href: addressUrl(address), rel: "noopener" }, shortHex(address));

function fact(term, ...value) {
  return [el("dt", {}, term), el("dd", {}, ...value)];
}

function renderBounty(b) {
  const t = now();
  const label = statusLabel(b.status);
  document.title = `${b.question.slice(0, 60)} · Errandkite`;
  const facts = [
    ...fact("Reward", el("span", { class: "reward" }, formatReward(b.reward_usd))),
    ...fact("Status", el("span", { class: `pill ${label.tone}` }, label.text)),
    ...fact("Answers", String(b.answer_count)),
    ...fact("Posted", `${timeAgo(b.created_at, t)} by ${b.source === "manual" ? "a person (test)" : "an agent"}`),
    ...fact("Closes", canAnswer(b, t) ? timeLeft(b.expires_at, t) : new Date(b.expires_at * 1000).toLocaleString()),
  ];
  if (b.payment_tx) facts.push(...fact("Paid into escrow", txLink(b.payment_tx)));
  if (b.payout_tx) facts.push(...fact("Paid out", txLink(b.payout_tx), " to ", addressLink(b.payout_to)));
  if (b.refund_tx) facts.push(...fact("Refund", txLink(b.refund_tx)));
  bountyEl.replaceChildren(el("h1", {}, b.question), el("div", { class: "panel" }, el("dl", { class: "facts" }, facts)));
}

function closedNotice(b) {
  const reason = {
    accepting: "The agent accepted an answer and the reward is being sent.",
    paid: "The agent accepted an answer and the reward was paid.",
    refunding: "The bounty closed without an accepted answer and is being refunded.",
    refunded: "The bounty closed without an accepted answer and was refunded.",
  }[b.status];
  return el("p", { class: "note" }, reason ?? "This bounty no longer takes answers.");
}

function renderForm(b) {
  const answer = el("textarea", { id: "answer-text", name: "answer", maxlength: MAX_ANSWER_CHARS, required: true, "aria-describedby": "answer-hint answer-error" });
  const address = el("input", {
    id: "payout-address", name: "payout_address", type: "text", required: true, autocomplete: "off", spellcheck: "false",
    placeholder: "0x…", "aria-describedby": "address-hint address-error",
  });
  const answerError = el("span", { id: "answer-error", class: "field-error" });
  const addressError = el("span", { id: "address-error", class: "field-error" });
  const formError = el("div", { role: "alert" });
  const submit = el("button", { type: "submit", class: "btn" }, "Send answer");

  const showErrors = (fields) => {
    answerError.textContent = fields.answer ?? "";
    addressError.textContent = fields.payoutAddress ?? "";
    answer.setAttribute("aria-invalid", String(Boolean(fields.answer)));
    address.setAttribute("aria-invalid", String(Boolean(fields.payoutAddress)));
  };

  const form = el(
    "form",
    { novalidate: true },
    el("label", { for: "answer-text" }, "Your answer", el("span", { id: "answer-hint", class: "hint" }, `Be specific. Up to ${MAX_ANSWER_CHARS} characters. No personal information.`), answer, answerError),
    el(
      "label",
      { for: "payout-address" },
      "Your Kite testnet wallet address",
      el("span", { id: "address-hint", class: "hint" }, "The reward is sent here if your answer is accepted. Any EVM wallet address works. Each address can answer once."),
      address,
      addressError,
    ),
    formError,
    el("div", {}, submit),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formError.replaceChildren();
    const checked = validateAnswerForm({ answer: answer.value, payoutAddress: address.value });
    showErrors(checked.errors);
    if (!checked.ok) return;

    submit.disabled = true;
    submit.textContent = "Sending…";
    try {
      const res = await fetch(`/api/bounties/${encodeURIComponent(b.id)}/answers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checked.value),
      });
      let body = null;
      try {
        body = await res.json();
      } catch {}
      if (!res.ok) {
        const { message, fields } = describeError(res.status, body);
        showErrors(fields);
        formError.replaceChildren(el("p", { class: "alert" }, message));
        return;
      }
      answerEl.replaceChildren(
        el("h2", {}, "Answer sent"),
        el(
          "div",
          { class: "success", role: "status" },
          el("p", {}, "Thanks. The agent will read the answers and may accept one before the bounty closes."),
          el("p", {}, "If yours is accepted, the reward goes to ", addressLink(body.answer.payout_address), ". Check this page or your wallet on KiteScan."),
        ),
      );
      load(); // refresh the answer count
    } catch {
      formError.replaceChildren(el("p", { class: "alert" }, "Could not reach the server. Your answer was not sent; please try again."));
    } finally {
      submit.disabled = false;
      submit.textContent = "Send answer";
    }
  });

  answerEl.replaceChildren(el("h2", {}, "Answer this bounty"), el("div", { class: "panel" }, form));
}

let formShown = false;

async function load() {
  if (!/^bty_[0-9a-f]{32}$/.test(id)) {
    bountyEl.replaceChildren(el("div", { class: "state error", role: "alert" }, "This link is not a valid bounty link."));
    return;
  }
  if (!bountyEl.hasChildNodes()) {
    bountyEl.setAttribute("aria-busy", "true");
    bountyEl.replaceChildren(el("div", { class: "state", role: "status" }, "Loading bounty…"));
  }
  try {
    const { bounty } = await fetchJson(`/api/bounties/${encodeURIComponent(id)}`);
    bountyEl.removeAttribute("aria-busy");
    renderBounty(bounty);
    if (canAnswer(bounty, now())) {
      if (!formShown) {
        renderForm(bounty);
        formShown = true;
      }
    } else {
      answerEl.replaceChildren(closedNotice(bounty));
    }
  } catch (err) {
    bountyEl.removeAttribute("aria-busy");
    const message = err.status === 404 ? "This bounty does not exist, or has not been paid for yet." : `Could not load the bounty. ${err.message}`;
    bountyEl.replaceChildren(el("div", { class: "state error", role: "alert" }, el("p", {}, message), err.status === 404 ? "" : el("button", { type: "button", onclick: () => load() }, "Try again")));
  }
}

load();

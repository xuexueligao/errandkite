import type { Config } from "./config.js";
import { decimalToUnits } from "./money.js";

export const QUESTION_MIN = 10;
export const QUESTION_MAX = 1000;
export const TTL_MIN_SECONDS = 10 * 60;
export const TTL_MAX_SECONDS = 72 * 60 * 60;
export const TTL_DEFAULT_SECONDS = 24 * 60 * 60;

export interface BountyInput {
  question: string;
  rewardUsd: string;
  rewardUnits: bigint;
  ttlSeconds: number;
  source: "agent" | "manual";
}

export interface FieldError {
  field: string;
  message: string;
}

export type ParseResult = { ok: true; value: BountyInput } | { ok: false; errors: FieldError[] };

/**
 * Validates a bounty request body. This runs before the x402 middleware, so a
 * request that fails here gets a 400 and is never asked to pay.
 */
export function parseBountyInput(body: unknown, config: Config): ParseResult {
  const errors: FieldError[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be a JSON object" }] };
  }
  const raw = body as Record<string, unknown>;

  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (typeof raw.question !== "string") errors.push({ field: "question", message: "is required and must be a string" });
  else if ([...question].length < QUESTION_MIN || [...question].length > QUESTION_MAX) {
    errors.push({ field: "question", message: `must be ${QUESTION_MIN} to ${QUESTION_MAX} characters` });
  }

  // The reward must be a string so "0.1" is not silently turned into a float.
  let rewardUnits: bigint | null = null;
  const rewardUsd = typeof raw.reward_usd === "string" ? raw.reward_usd.trim() : "";
  if (typeof raw.reward_usd !== "string") {
    errors.push({ field: "reward_usd", message: 'is required and must be a decimal string such as "0.10"' });
  } else {
    rewardUnits = decimalToUnits(rewardUsd, config.chain.assetDecimals);
    if (rewardUnits === null) {
      errors.push({ field: "reward_usd", message: `must be a plain decimal with at most ${config.chain.assetDecimals} decimals` });
    } else if (rewardUnits < config.minRewardUnits || rewardUnits > config.maxRewardUnits) {
      errors.push({ field: "reward_usd", message: `must be between ${config.minRewardUsd} and ${config.maxRewardUsd}` });
    }
  }

  let ttlSeconds = TTL_DEFAULT_SECONDS;
  if (raw.ttl_seconds !== undefined) {
    if (typeof raw.ttl_seconds !== "number" || !Number.isInteger(raw.ttl_seconds)) {
      errors.push({ field: "ttl_seconds", message: "must be an integer" });
    } else if (raw.ttl_seconds < TTL_MIN_SECONDS || raw.ttl_seconds > TTL_MAX_SECONDS) {
      errors.push({ field: "ttl_seconds", message: `must be between ${TTL_MIN_SECONDS} and ${TTL_MAX_SECONDS}` });
    } else {
      ttlSeconds = raw.ttl_seconds;
    }
  }

  let source: BountyInput["source"] = "agent";
  if (raw.source !== undefined) {
    if (raw.source !== "agent" && raw.source !== "manual") errors.push({ field: "source", message: 'must be "agent" or "manual"' });
    else source = raw.source;
  }

  if (errors.length > 0 || rewardUnits === null) return { ok: false, errors };
  return { ok: true, value: { question, rewardUsd, rewardUnits, ttlSeconds, source } };
}

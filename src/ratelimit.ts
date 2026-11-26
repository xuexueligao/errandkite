import { hashToken } from "./tokens.js";

export interface RateLimit {
  bucket: string;
  max: number;
  windowSeconds: number;
}

/** Answers per client IP, and per payout address across all bounties. */
export const ANSWER_LIMITS = {
  ip: { bucket: "answer_ip", max: 10, windowSeconds: 10 * 60 },
  address: { bucket: "answer_address", max: 20, windowSeconds: 60 * 60 },
} as const satisfies Record<string, RateLimit>;

/** Hits are kept this long; it must be at least the longest window. */
export const RATE_HIT_RETENTION_SECONDS = 24 * 60 * 60;

/** Stored keys are hashes, so the table never holds raw IP addresses. */
export const rateKey = (value: string) => hashToken(value.trim().toLowerCase());

/**
 * Seconds until `key` may act again under `limit`, or 0 if it may act now.
 * The check and the later recordHits are separate statements, so a burst of
 * parallel requests can overshoot the limit by a few. That is acceptable for
 * spam control; it does not guard money.
 */
export async function retryAfter(db: D1Database, limit: RateLimit, key: string, now: number): Promise<number> {
  // The max-th most recent hit in the window. If it exists the limit is reached,
  // and it frees a slot when it leaves the window.
  const row = await db
    .prepare(
      `SELECT created_at FROM rate_hits WHERE bucket = ? AND key = ? AND created_at > ?
       ORDER BY created_at DESC LIMIT 1 OFFSET ?`,
    )
    .bind(limit.bucket, key, now - limit.windowSeconds, limit.max - 1)
    .first<{ created_at: number }>();
  return row ? Math.max(1, row.created_at + limit.windowSeconds - now) : 0;
}

export async function recordHits(db: D1Database, hits: { limit: RateLimit; key: string }[], now: number): Promise<void> {
  if (hits.length === 0) return;
  await db.batch(hits.map(({ limit, key }) => db.prepare(`INSERT INTO rate_hits (bucket, key, created_at) VALUES (?, ?, ?)`).bind(limit.bucket, key, now)));
}

export async function pruneRateHits(db: D1Database, now: number): Promise<number> {
  const result = await db.prepare(`DELETE FROM rate_hits WHERE created_at <= ?`).bind(now - RATE_HIT_RETENTION_SECONDS).run();
  return result.meta.changes ?? 0;
}

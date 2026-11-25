const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Random identifier for a bounty, e.g. "bty_3f9a…" (16 random bytes). */
export function newBountyId(): string {
  return `bty_${toHex(crypto.getRandomValues(new Uint8Array(16)))}`;
}

/** Random identifier for an answer, e.g. "ans_3f9a…" (16 random bytes). */
export function newAnswerId(): string {
  return `ans_${toHex(crypto.getRandomValues(new Uint8Array(16)))}`;
}

/** Secret the poster uses to read answers, accept or cancel. Returned once, never stored. */
export function newManageToken(): string {
  return `mt_${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

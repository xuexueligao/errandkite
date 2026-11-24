/**
 * Converts a plain decimal string such as "0.10" into token base units with
 * integer math, so no precision is lost to floating point. Returns null for
 * anything that is not a plain non-negative decimal, or that has more
 * fractional digits than the token supports.
 */
export function decimalToUnits(value: string, decimals: number): bigint | null {
  const match = /^(\d{1,12})(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  if (fraction.length > decimals) return null;
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import type { Env } from "../src/env.js";
import { decimalToUnits } from "../src/money.js";
import { parseBountyInput, TTL_DEFAULT_SECONDS, TTL_MAX_SECONDS, TTL_MIN_SECONDS } from "../src/validation.js";

const baseEnv = {
  KITE_NETWORK: "testnet",
  PAY_TO: "0x7ec512bAcF9F3a1EC024F9bC5AbFDA3836ADDEa9",
  MIN_REWARD_USD: "0.01",
  MAX_REWARD_USD: "1",
} as Env;
const config = loadConfig(baseEnv);
const valid = { question: "Does example.com load on a phone in Brazil?", reward_usd: "0.10" };

describe("decimalToUnits", () => {
  it("converts with integer math", () => {
    expect(decimalToUnits("0.10", 18)).toBe(100_000_000_000_000_000n);
    expect(decimalToUnits("1", 18)).toBe(10n ** 18n);
    expect(decimalToUnits("0.000000000000000001", 18)).toBe(1n);
  });

  it("rejects anything that is not a plain decimal", () => {
    for (const bad of ["", "abc", "-1", "1e-2", ".5", "0.", "1,0", " 1", "0x10"]) {
      expect(decimalToUnits(bad, 18), bad).toBeNull();
    }
    expect(decimalToUnits("0.0000000000000000001", 18)).toBeNull();
  });
});

describe("loadConfig", () => {
  it("accepts the testnet configuration", () => {
    expect(config.chain.network).toBe("eip155:2368");
    expect(config.minRewardUnits).toBe(10n ** 16n);
    expect(config.maxRewardUnits).toBe(10n ** 18n);
  });

  it("refuses mainnet and bad values", () => {
    expect(() => loadConfig({ ...baseEnv, KITE_NETWORK: "mainnet" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, PAY_TO: "not-an-address" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, MIN_REWARD_USD: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, MAX_REWARD_USD: "0.001" })).toThrow(ConfigError);
  });
});

describe("parseBountyInput", () => {
  it("accepts a valid bounty and fills defaults", () => {
    const result = parseBountyInput(valid, config);
    expect(result).toEqual({
      ok: true,
      value: { question: valid.question, rewardUsd: "0.10", rewardUnits: 10n ** 17n, ttlSeconds: TTL_DEFAULT_SECONDS, source: "agent" },
    });
  });

  it("accepts the reward and ttl bounds exactly", () => {
    for (const [reward, ttl] of [["0.01", TTL_MIN_SECONDS], ["1", TTL_MAX_SECONDS], ["1.000", TTL_MAX_SECONDS]] as const) {
      expect(parseBountyInput({ ...valid, reward_usd: reward, ttl_seconds: ttl }, config).ok, reward).toBe(true);
    }
  });

  it.each([
    ["not an object", "hello", "body"],
    ["array body", [valid], "body"],
    ["missing question", { reward_usd: "0.10" }, "question"],
    ["question too short", { ...valid, question: "   short   " }, "question"],
    ["question too long", { ...valid, question: "x".repeat(1001) }, "question"],
    ["reward as a number", { ...valid, reward_usd: 0.1 }, "reward_usd"],
    ["reward below minimum", { ...valid, reward_usd: "0.009" }, "reward_usd"],
    ["reward above maximum", { ...valid, reward_usd: "1.000000000000000001" }, "reward_usd"],
    ["reward with too many decimals", { ...valid, reward_usd: "0.1000000000000000001" }, "reward_usd"],
    ["negative reward", { ...valid, reward_usd: "-0.10" }, "reward_usd"],
    ["ttl too short", { ...valid, ttl_seconds: TTL_MIN_SECONDS - 1 }, "ttl_seconds"],
    ["ttl too long", { ...valid, ttl_seconds: TTL_MAX_SECONDS + 1 }, "ttl_seconds"],
    ["ttl not an integer", { ...valid, ttl_seconds: 3600.5 }, "ttl_seconds"],
    ["unknown source", { ...valid, source: "bot" }, "source"],
  ])("rejects %s", (_name, body, field) => {
    const result = parseBountyInput(body, config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.field)).toContain(field);
  });

  it("counts characters, not UTF-16 units, for the question length", () => {
    expect(parseBountyInput({ ...valid, question: "这个网站在你那边能打开吗？" }, config).ok).toBe(true);
  });
});

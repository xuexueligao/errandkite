import { getAddress, isAddress } from "viem";
import type { Env } from "./env.js";
import { FACILITATOR_URL, type KiteChain, kiteChainByName } from "./kite.js";
import { decimalToUnits } from "./money.js";

export interface Config {
  chain: KiteChain;
  payTo: `0x${string}`;
  facilitatorUrl: string;
  minRewardUnits: bigint;
  maxRewardUnits: bigint;
  minRewardUsd: string;
  maxRewardUsd: string;
}

export class ConfigError extends Error {}

/** Reads and checks the Worker configuration. Throws ConfigError on bad values. */
export function loadConfig(env: Env): Config {
  const chain = kiteChainByName(env.KITE_NETWORK);
  if (chain.network !== "eip155:2368") {
    // Paying real people on mainnet raises tax and identity questions that v0.1 does not handle.
    throw new ConfigError(`KITE_NETWORK must be "testnet" in v0.1, got "${env.KITE_NETWORK}"`);
  }
  const payTo = (env.PAY_TO ?? "").trim();
  if (!isAddress(payTo, { strict: false })) throw new ConfigError("PAY_TO must be an EVM address");

  const minRewardUsd = (env.MIN_REWARD_USD ?? "").trim();
  const maxRewardUsd = (env.MAX_REWARD_USD ?? "").trim();
  const minRewardUnits = decimalToUnits(minRewardUsd, chain.assetDecimals);
  const maxRewardUnits = decimalToUnits(maxRewardUsd, chain.assetDecimals);
  if (minRewardUnits === null || minRewardUnits <= 0n) throw new ConfigError("MIN_REWARD_USD must be a positive decimal");
  if (maxRewardUnits === null || maxRewardUnits < minRewardUnits) {
    throw new ConfigError("MAX_REWARD_USD must be a decimal no smaller than MIN_REWARD_USD");
  }

  return {
    chain,
    payTo: getAddress(payTo),
    facilitatorUrl: (env.FACILITATOR_URL ?? "").trim() || FACILITATOR_URL,
    minRewardUnits,
    maxRewardUnits,
    minRewardUsd,
    maxRewardUsd,
  };
}

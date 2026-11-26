import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.js";
import type { Hex, TokenTransfers, TxStatus } from "./transfers.js";

/** Errors that mean the nonce is already used, so the transaction can never be mined. */
const NONCE_USED = /nonce too low|nonce has already been used|replacement transaction underpriced|invalid nonce/i;
/** The node already has this exact transaction. */
const ALREADY_KNOWN = /already known|known transaction|already imported/i;

export class TransferConfigError extends Error {}

function viemChain(config: Config) {
  const chainId = Number(config.chain.network.split(":")[1]);
  return defineChain({
    id: chainId,
    name: `Kite ${chainId}`,
    nativeCurrency: { name: "KITE", symbol: "KITE", decimals: 18 },
    rpcUrls: { default: { http: [config.chain.rpcUrl] } },
  });
}

/** Read-only view of the platform wallet (PAY_TO). Needs no private key. */
export interface EscrowReader {
  /** pieUSD held by the wallet, in base units. */
  tokenBalance(): Promise<bigint>;
  /** Native KITE for gas, in wei. */
  gasBalance(): Promise<bigint>;
}

export function createEscrowReader(config: Config): EscrowReader {
  const client = createPublicClient({ chain: viemChain(config), transport: http(config.chain.rpcUrl, { timeout: 12_000 }) });
  return {
    tokenBalance: () =>
      client.readContract({ address: getAddress(config.chain.assetAddress), abi: erc20Abi, functionName: "balanceOf", args: [config.payTo] }),
    gasBalance: () => client.getBalance({ address: config.payTo }),
  };
}

/**
 * pieUSD transfers from the platform wallet, signed with PLATFORM_PRIVATE_KEY.
 * The key must belong to PAY_TO, the wallet that receives bounty payments.
 */
export function createChainTransfers(config: Config, privateKey: string): TokenTransfers {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey.trim())) throw new TransferConfigError("PLATFORM_PRIVATE_KEY must be 0x followed by 64 hex characters");
  const account = privateKeyToAccount(privateKey.trim() as Hex);
  if (getAddress(account.address) !== config.payTo) {
    throw new TransferConfigError("PLATFORM_PRIVATE_KEY does not belong to PAY_TO");
  }

  const chain = viemChain(config);
  const client = createPublicClient({ chain, transport: http(config.chain.rpcUrl, { timeout: 15_000 }) });
  const wallet = createWalletClient({ account, chain, transport: http(config.chain.rpcUrl, { timeout: 15_000 }) });
  const asset = getAddress(config.chain.assetAddress);

  const status = async (hash: Hex): Promise<TxStatus> => {
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      return receipt.status === "success" ? "success" : "reverted";
    } catch (err) {
      if (!(err instanceof TransactionReceiptNotFoundError)) throw err;
    }
    try {
      await client.getTransaction({ hash });
      return "pending";
    } catch (err) {
      if (err instanceof TransactionNotFoundError) return "not_found";
      throw err;
    }
  };

  return {
    async sign(to, amount) {
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(to), amount] });
      const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
      const request = await wallet.prepareTransactionRequest({ to: asset, data, nonce });
      const raw = await wallet.signTransaction(request);
      return { hash: keccak256(raw), raw };
    },
    async broadcast(raw) {
      try {
        await client.sendRawTransaction({ serializedTransaction: raw });
        return "sent";
      } catch (err) {
        const text = String((err as Error).message ?? err);
        if (ALREADY_KNOWN.test(text)) return "sent";
        if (NONCE_USED.test(text)) return "nonce_used";
        throw err;
      }
    },
    status,
    async waitFor(hash, timeoutMs) {
      try {
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 1_000 });
        return receipt.status === "success" ? "success" : "reverted";
      } catch (err) {
        if (err instanceof WaitForTransactionReceiptTimeoutError) return status(hash);
        throw err;
      }
    },
  };
}

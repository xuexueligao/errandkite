import { keccak256, toHex } from "viem";
import type { Hex, TokenTransfers, TxStatus } from "../src/transfers.js";

export interface FakeTx {
  hash: Hex;
  raw: Hex;
  to: Hex;
  amount: bigint;
  nonce: number;
}

/**
 * An in-memory chain for the platform wallet. It models the one property the
 * payout logic relies on: each nonce can be used by at most one transaction.
 */
export class FakeChain implements TokenTransfers {
  signed: FakeTx[] = [];
  /** Transactions the "node" accepted, by hash. */
  mempool = new Map<Hex, FakeTx>();
  /** nonce -> hash of the transaction that used it. */
  mined = new Map<number, Hex>();
  reverted = new Set<Hex>();
  nextNonce = 0;
  broadcasts = 0;

  /** Behaviour switches for failure tests. */
  mineOnBroadcast = true;
  failBroadcast = 0; // throw on the next N broadcasts, after the node accepted them
  dropBroadcast = 0; // throw on the next N broadcasts, before the node saw them
  failSign: Error | null = null;
  revertNext = 0;

  async sign(to: Hex, amount: bigint) {
    if (this.failSign) throw this.failSign;
    // Like eth_getTransactionCount("pending"): mined plus in the mempool.
    const used = new Set([...this.mined.keys(), ...[...this.mempool.values()].map((t) => t.nonce)]);
    let nonce = this.nextNonce;
    while (used.has(nonce)) nonce++;
    const raw = toHex(`tx:${to}:${amount}:${nonce}:${this.signed.length}`);
    const tx: FakeTx = { hash: keccak256(raw), raw, to, amount, nonce };
    this.signed.push(tx);
    return { hash: tx.hash, raw };
  }

  async broadcast(raw: Hex): Promise<"sent" | "nonce_used"> {
    this.broadcasts++;
    if (this.dropBroadcast > 0) {
      this.dropBroadcast--;
      throw new Error("fetch failed");
    }
    const tx = this.signed.find((t) => t.raw === raw);
    if (!tx) throw new Error("unknown raw tx");
    const usedBy = this.mined.get(tx.nonce);
    if (usedBy && usedBy !== tx.hash) return "nonce_used";
    if (!usedBy) {
      this.mempool.set(tx.hash, tx);
      if (this.mineOnBroadcast) this.mine();
    }
    if (this.failBroadcast > 0) {
      this.failBroadcast--;
      throw new Error("timeout waiting for the node");
    }
    return "sent";
  }

  /** Mines everything in the mempool whose nonce is still free. */
  mine() {
    for (const tx of this.mempool.values()) {
      if (!this.mined.has(tx.nonce)) {
        this.mined.set(tx.nonce, tx.hash);
        if (this.revertNext > 0) {
          this.revertNext--;
          this.reverted.add(tx.hash);
        }
      }
    }
    this.mempool.clear();
  }

  async status(hash: Hex): Promise<TxStatus> {
    if ([...this.mined.values()].includes(hash)) return this.reverted.has(hash) ? "reverted" : "success";
    if (this.mempool.has(hash)) return "pending";
    return "not_found";
  }

  async waitFor(hash: Hex): Promise<TxStatus> {
    return this.status(hash);
  }

  /** Successful transfers that actually moved tokens. */
  paid(): FakeTx[] {
    return [...this.mined.values()].filter((h) => !this.reverted.has(h)).map((h) => this.signed.find((t) => t.hash === h)!);
  }
}

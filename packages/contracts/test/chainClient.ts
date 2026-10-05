import { ethers } from "hardhat";
import type { ChainClient } from "../scripts/lib/chain";

/** A ChainClient over the in-process Hardhat node, so the real orchestration runs against a real chain. */
export function hardhatClient(signer: any): ChainClient {
  const provider = ethers.provider;
  return {
    deployer: signer.address,
    getChainId: async () => (await provider.getNetwork()).chainId,
    getBalance: a => provider.getBalance(a),
    getGasPrice: async () => (await provider.getFeeData()).gasPrice!,
    getBlockNumber: () => provider.getBlockNumber(),
    getCode: a => provider.getCode(a),
    call: (to, data) => provider.call({ to, data }),
    estimateCreate: data => provider.estimateGas({ from: signer.address, data }),
    estimateCall: (to, data) => provider.estimateGas({ from: signer.address, to, data }),
    sendCreate: async (data, gasLimit) => (await signer.sendTransaction({ data, gasLimit })).hash,
    sendCall: async (to, data, gasLimit) => (await signer.sendTransaction({ to, data, gasLimit })).hash,
    getReceipt: async h => {
      const r = await provider.getTransactionReceipt(h);
      return r ? { status: r.status ?? 0, contractAddress: r.contractAddress, blockNumber: r.blockNumber, gasUsed: r.gasUsed } : null;
    }
  };
}

export const FAST = { pollMs: 5, timeoutMs: 3000, log: () => {} };

/** Wraps a client so the Nth creation / Nth call throws (a dropped connection), and counts every send. */
export function flaky(base: ChainClient, opts: { failCreate?: number; failCall?: number } = {}) {
  const counters = { creates: 0, calls: 0 };
  const client: ChainClient = {
    ...base,
    sendCreate: async (d, g) => {
      counters.creates++;
      if (opts.failCreate === counters.creates) throw new Error("simulated network failure (create)");
      return base.sendCreate(d, g);
    },
    sendCall: async (to, d, g) => {
      counters.calls++;
      if (opts.failCall === counters.calls) throw new Error("simulated network failure (call)");
      return base.sendCall(to, d, g);
    }
  };
  return { client, counters };
}

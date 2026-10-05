import { Interface } from "ethers";
import type { Artifact } from "./artifacts";
import type { ChainClient, TxReceipt } from "./chain";

export interface DeployOptions {
    label: string;
    /** false = simulate only: estimate gas and check funds, send nothing. */
    broadcast: boolean;
    /** Creation gas on Quai is ~2.5x the simulator's estimate; a revert burns the whole limit. */
    gasMultiplier?: number;
    pollMs?: number;
    timeoutMs?: number;
    /** Blocks that must be built on top of the receipt's block before the deployment is accepted. */
    confirmations?: number;
    /** Chain-specific rule for a valid deployed address (e.g. must be a Cyprus-1 address). Throw to reject. */
    checkAddress?: (address: string) => void;
    log?: (line: string) => void;
}

export interface DeployResult {
    dryRun: boolean;
    label: string;
    estimatedGas: bigint;
    gasLimit: bigint;
    /** gasLimit * gasPrice: the most this transaction can cost. */
    maxFee: bigint;
    /** True when this contract was adopted from an earlier interrupted run rather than deployed now. */
    resumed?: boolean;
    /** True when the gas figure is a projection (from bytecode size), not a simulation of this constructor. */
    projected?: boolean;
    /** Present only when broadcast. */
    address?: string;
    txHash?: string;
    blockNumber?: number;
    gasUsed?: bigint;
}

const FULL_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * The deployed address, taken from the transaction receipt and nowhere else. It must be the complete
 * 20-byte address: a missing, truncated or malformed value is an error, and there is no fallback to an
 * address computed from the sender and nonce (Quai grinds contract addresses, so a computed one can be
 * wrong, and a wrong address means funds sent to nothing).
 */
export function contractAddressFromReceipt(receipt: TxReceipt | null | undefined, txHash: string): string {
    if (!receipt) throw new Error(`No receipt for ${txHash}`);
    if (receipt.status !== 1) throw new Error(`Transaction ${txHash} reverted on-chain`);
    const addr = receipt.contractAddress;
    if (!addr) {
        throw new Error(`Receipt for ${txHash} has no contractAddress; refusing to derive one from sender and nonce`);
    }
    if (!FULL_ADDRESS.test(addr)) {
        throw new Error(`Receipt for ${txHash} carries a malformed contractAddress "${addr}" (need the full 20-byte address)`);
    }
    return addr;
}

/** Deploys one contract: simulate, size gas, send, wait, then read and verify the address off the receipt. */
export async function deployContract(
    client: ChainClient,
    artifact: Artifact,
    args: unknown[],
    opts: DeployOptions
): Promise<DeployResult> {
    const log = opts.log ?? (() => {});
    const iface = new Interface(artifact.abi);
    const data = artifact.bytecode + iface.encodeDeploy(args).slice(2);

    let estimatedGas: bigint;
    try {
        estimatedGas = await client.estimateCreate(data);
    } catch (e: any) {
        throw new Error(`${opts.label}: simulation failed, nothing sent: ${e.message}`);
    }
    const multiplier = opts.gasMultiplier ?? 3;
    const gasLimit = (estimatedGas * BigInt(Math.round(multiplier * 100))) / 100n;
    const gasPrice = await client.getGasPrice();
    const maxFee = gasLimit * gasPrice;

    const balance = await client.getBalance(client.deployer);
    log(`${opts.label}: estimate ${estimatedGas} gas, limit ${gasLimit}, max fee ${maxFee} wei`);
    if (opts.broadcast && balance < maxFee) {
        throw new Error(`${opts.label}: deployer holds ${balance} wei but the gas limit can cost up to ${maxFee} wei`);
    }

    if (!opts.broadcast) return { dryRun: true, label: opts.label, estimatedGas, gasLimit, maxFee };

    const txHash = await client.sendCreate(data, gasLimit);
    log(`${opts.label}: sent ${txHash}`);
    const receipt = await waitForReceipt(client, txHash, opts);

    const address = contractAddressFromReceipt(receipt, txHash);
    opts.checkAddress?.(address);

    const code = await client.getCode(address);
    if (!code || code === "0x") {
        throw new Error(`${opts.label}: receipt says ${address} but no code is deployed there`);
    }
    const expectedBytes = (artifact.deployedBytecode.length - 2) / 2;
    const gotBytes = (code.length - 2) / 2;
    if (gotBytes !== expectedBytes) {
        throw new Error(`${opts.label}: code at ${address} is ${gotBytes} bytes, compiled runtime is ${expectedBytes}`);
    }

    log(`${opts.label}: deployed at ${address} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
    return {
        dryRun: false,
        label: opts.label,
        estimatedGas,
        gasLimit,
        maxFee,
        address,
        txHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed
    };
}

/** Polls for a receipt, then waits for the requested confirmations and re-reads it to catch a reorg. */
export async function waitForReceipt(client: ChainClient, txHash: string, opts: DeployOptions): Promise<TxReceipt> {
    const pollMs = opts.pollMs ?? 1500;
    const timeoutMs = opts.timeoutMs ?? 240_000;
    const confirmations = opts.confirmations ?? 0;
    const start = Date.now();

    let receipt: TxReceipt | null = null;
    while (Date.now() - start < timeoutMs) {
        receipt = await client.getReceipt(txHash);
        if (receipt) break;
        await sleep(pollMs);
    }
    if (!receipt) {
        throw new Error(`${opts.label}: ${txHash} was not mined within ${timeoutMs} ms; check the explorer before retrying`);
    }
    if (receipt.status !== 1) throw new Error(`${opts.label}: ${txHash} reverted on-chain`);

    while (confirmations > 0 && Date.now() - start < timeoutMs) {
        if ((await client.getBlockNumber()) >= receipt.blockNumber + confirmations) {
            const again = await client.getReceipt(txHash);
            if (!again || again.blockNumber !== receipt.blockNumber) {
                throw new Error(`${opts.label}: ${txHash} moved or vanished after ${confirmations} confirmations (reorg?)`);
            }
            return again;
        }
        await sleep(pollMs);
    }
    if (confirmations > 0) throw new Error(`${opts.label}: ${txHash} did not reach ${confirmations} confirmations in time`);
    return receipt;
}

/** Simulates, sends a call, and waits for it to succeed. */
export async function sendAndWait(
    client: ChainClient,
    to: string,
    data: string,
    opts: DeployOptions
): Promise<{ txHash: string; receipt: TxReceipt }> {
    const estimate = await client.estimateCall(to, data);
    const gasLimit = (estimate * 150n) / 100n;
    const txHash = await client.sendCall(to, data, gasLimit);
    return { txHash, receipt: await waitForReceipt(client, txHash, opts) };
}

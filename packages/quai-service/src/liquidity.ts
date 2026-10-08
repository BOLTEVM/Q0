// Uniswap-V2 style liquidity helpers: pair lookup, allowance, add-liquidity encoding and quoting,
// and the gas / access-list preparation Cyprus-1 needs before a contract call is signed.
//
// Selectors (keccak256 of the canonical signature, checked with ethers.id):
//   getPair(address,address)                                                 0xe6a43905
//   allowance(address,address)                                               0xdd62ed3e
//   approve(address,uint256)                                                 0x095ea7b3
//   addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) 0xe8e33700
//   addLiquidityETH(address,uint256,uint256,uint256,address,uint256)          0xf305d719
//   removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)       0x02751cec

import { quaiRpcCall, quaiCall, DEFAULT_RPC } from './index';
import { requireDex, tokenAddress, type DexId } from './registries/pools';
import { clampSlippagePct } from './units';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const word = (n: bigint) => n.toString(16).padStart(64, '0');
const addrWord = (a: string) => a.replace('0x', '').toLowerCase().padStart(64, '0');

export function encodeApprove(spender: string, amount: bigint): string {
    return '0x095ea7b3' + addrWord(spender) + word(amount);
}

export function encodeAddLiquidity(p: {
    tokenA: string;
    tokenB: string;
    amountADesired: bigint;
    amountBDesired: bigint;
    amountAMin: bigint;
    amountBMin: bigint;
    to: string;
    deadline: bigint;
}): string {
    return (
        '0xe8e33700' +
        addrWord(p.tokenA) +
        addrWord(p.tokenB) +
        word(p.amountADesired) +
        word(p.amountBDesired) +
        word(p.amountAMin) +
        word(p.amountBMin) +
        addrWord(p.to) +
        word(p.deadline)
    );
}

/** Encode the Circleswap native-QUAI liquidity entrypoint. The router wraps the value into WQUAI. */
export function encodeAddLiquidityETH(p: {
    token: string;
    amountTokenDesired: bigint;
    amountTokenMin: bigint;
    amountETHMin: bigint;
    to: string;
    deadline: bigint;
}): string {
    return (
        '0xf305d719' +
        addrWord(p.token) +
        word(p.amountTokenDesired) +
        word(p.amountTokenMin) +
        word(p.amountETHMin) +
        addrWord(p.to) +
        word(p.deadline)
    );
}

/** Encode native-QUAI withdrawal from a pool whose on-chain second token is WQUAI. */
export function encodeRemoveLiquidityETH(p: {
    token: string;
    liquidity: bigint;
    amountTokenMin: bigint;
    amountETHMin: bigint;
    to: string;
    deadline: bigint;
}): string {
    return (
        '0x02751cec' +
        addrWord(p.token) +
        word(p.liquidity) +
        word(p.amountTokenMin) +
        word(p.amountETHMin) +
        addrWord(p.to) +
        word(p.deadline)
    );
}

export async function getAllowance(token: string, owner: string, spender: string): Promise<bigint> {
    const hex = await quaiCall(token, '0xdd62ed3e' + addrWord(owner) + addrWord(spender));
    return !hex || hex === '0x' ? 0n : BigInt(hex);
}

/** Pair address for two tokens on a DEX, or null if the factory has not created it yet. */
export async function getPairAddress(dex: DexId, symbolA: string, symbolB: string): Promise<string | null> {
    const { factory, label } = requireDex(dex);
    const hex = await quaiCall(factory, '0xe6a43905' + addrWord(tokenAddress(symbolA)) + addrWord(tokenAddress(symbolB)));
    // A reply that is not a full 32-byte word means the factory address is not a contract (or the node
    // misbehaved). Treating it as "a pair exists" would send liquidity to garbage.
    if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(`Unexpected reply from ${label} factory getPair: ${String(hex).slice(0, 40)}`);
    }
    const addr = '0x' + hex.slice(-40);
    return addr === ZERO_ADDRESS ? null : addr;
}

/** Uniswap V2 `quote`: the matching amount of B for `amountA` at the pool's current ratio. */
export function quoteLiquidityB(amountA: bigint, reserveA: bigint, reserveB: bigint): bigint {
    if (amountA <= 0n || reserveA <= 0n || reserveB <= 0n) return 0n;
    return (amountA * reserveB) / reserveA;
}

/** Minimum amounts the router must honour, given a slippage tolerance in percent. */
export function applySlippage(amount: bigint, slippagePct: number): bigint {
    const factor = 10000n - BigInt(Math.floor(clampSlippagePct(slippagePct) * 100));
    return (amount * factor) / 10000n;
}

export interface PreparedTx {
    tx: { from: string; to: string; data: string; gas: string; value?: string; accessList?: any[] };
    gasLimit: bigint;
    gasPrice: bigint;
    /** gasLimit * gasPrice, in wei: the most this transaction can cost. */
    maxFee: bigint;
}

/**
 * Simulate a contract call, attach the access list Cyprus-1 requires, and size the gas limit.
 * Throws if the simulation reverts, so a doomed transaction is never sent: on Quai a revert burns the
 * entire gas limit, which for a pair-creating call is a large amount of QUAI.
 *
 * `gasMultiplier` pads the estimate; unused gas is refunded on success.
 */
export async function prepareContractCall(
    from: string,
    to: string,
    data: string,
    gasMultiplier: number,
    rpcUrl: string = DEFAULT_RPC,
    value: bigint = 0n
): Promise<PreparedTx> {
    const base = { from, to, data, ...(value > 0n ? { value: '0x' + value.toString(16) } : {}) };

    let estimate: bigint;
    try {
        estimate = BigInt(await quaiRpcCall('quai_estimateGas', [base], rpcUrl));
    } catch (e: any) {
        throw new Error(`Simulation failed, transaction not sent: ${e.message}`);
    }

    let accessList: any[] | undefined;
    try {
        const res = await quaiRpcCall('quai_createAccessList', [base], rpcUrl);
        accessList = res?.accessList;
    } catch (e: any) {
        throw new Error(`Could not build the access list, transaction not sent: ${e.message}`);
    }

    const gasLimit = (estimate * BigInt(Math.round(gasMultiplier * 100))) / 100n;
    const gasPrice = BigInt(await quaiRpcCall('quai_gasPrice', [], rpcUrl));
    return {
        tx: { ...base, gas: '0x' + gasLimit.toString(16), ...(accessList && accessList.length ? { accessList } : {}) },
        gasLimit,
        gasPrice,
        maxFee: gasLimit * gasPrice
    };
}

/** Poll for a receipt; resolves on status 1, throws on revert or timeout. */
export async function waitForReceipt(txHash: string, timeoutMs: number = 180000, rpcUrl: string = DEFAULT_RPC): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        let receipt: any = null;
        try {
            receipt = await quaiRpcCall('quai_getTransactionReceipt', [txHash], rpcUrl);
        } catch {
            /* transient RPC error: keep polling */
        }
        if (receipt) {
            if (receipt.status === '0x1' || receipt.status === 1) return receipt;
            throw new Error('Transaction reverted on-chain.');
        }
        await new Promise(r => setTimeout(r, 1500));
    }
    throw new Error('Transaction was not mined in time. It may still confirm; check the explorer before retrying.');
}

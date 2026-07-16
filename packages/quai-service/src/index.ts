// Quai Network On-chain Service and Analytics client

export const CONTRACTS = {
    Q0: '0x00325150094E51107a931980Fdfc3bB1a4C48379',
    WQUAI: '0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB',
    BOSS: '0x004afdb66677d177b759356d2367aea3a79fe58b',
    LP_WQUAI: '0x003B4b96bF0793EB1D53B79f8c38746A298eEef8',
    LP_BOSS: '0x0036c1A5e62597438cC204F8613c15211D4b7787'
};

export const DEFAULT_RPC = 'https://rpc.quai.network/cyprus1';
export const DEFAULT_EXPLORER = 'https://quaiscan.io';

// ERC20 function selectors
export const SELECTORS = {
    name: '0x06fdde03',
    symbol: '0x95d89b41',
    decimals: '0x313ce567',
    totalSupply: '0x18160ddd',
    balanceOf: '0x70a08231',
    token0: '0x0dfe1681',
    token1: '0xd21220a7',
    getReserves: '0x0902f1ac'
};

export interface TokenMetadata {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string;
}

export interface LPReserves {
    reserve0: string;
    reserve1: string;
    blockTime: number;
    token0: string;
    token1: string;
}

export interface TransferEvent {
    tx_hash: string;
    timestamp: string;
    from: string;
    to: string;
    value: string;
    block_number: number;
}

export interface HolderInfo {
    address: string;
    balance: string;
}

export interface SwapSimulation {
    amountIn: string;
    amountOut: string;
    priceImpact: string;
    minimumReceived: string;
    executionPrice: string;
}

// Low-level helper to execute a fetch JSON-RPC
export async function quaiRpcCall(method: string, params: any[], rpcUrl: string = DEFAULT_RPC): Promise<any> {
    const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method,
            params,
            id: Date.now()
        })
    });
    if (!res.ok) {
        throw new Error(`RPC request failed: ${res.statusText}`);
    }
    const json = await res.json();
    if (json.error) {
        throw new Error(`RPC error: ${json.error.message} (${json.error.code})`);
    }
    return json.result;
}

// Low-level helper to call read-only contract functions
export async function quaiCall(to: string, data: string, rpcUrl: string = DEFAULT_RPC): Promise<string> {
    return await quaiRpcCall('quai_call', [{ to, data }, 'latest'], rpcUrl);
}

// Decode ERC-20 Strings (e.g. name, symbol)
export function decodeString(hex: string): string {
    if (!hex || hex === '0x') return '';
    let data = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (data.length < 128) return hex;
    const lenHex = data.slice(64, 128);
    const length = parseInt(lenHex, 16);
    const strHex = data.slice(128, 128 + length * 2);
    let str = '';
    for (let i = 0; i < strHex.length; i += 2) {
        str += String.fromCharCode(parseInt(strHex.substr(i, 2), 16));
    }
    return str.replace(/\0/g, '');
}

// Decode ERC-20 Ints (e.g. decimals)
export function decodeInt(hex: string): number {
    if (!hex || hex === '0x') return 0;
    return parseInt(hex, 16);
}

// Decode ERC-20 BigInts (e.g. totalSupply)
export function decodeBigInt(hex: string): bigint {
    if (!hex || hex === '0x') return 0n;
    return BigInt(hex.startsWith('0x') ? hex : '0x' + hex);
}

// Get Token metadata from chain
export async function getTokenMetadata(tokenAddress: string, rpcUrl: string = DEFAULT_RPC): Promise<TokenMetadata> {
    const [nameHex, symbolHex, decimalsHex, supplyHex] = await Promise.all([
        quaiCall(tokenAddress, SELECTORS.name, rpcUrl),
        quaiCall(tokenAddress, SELECTORS.symbol, rpcUrl),
        quaiCall(tokenAddress, SELECTORS.decimals, rpcUrl),
        quaiCall(tokenAddress, SELECTORS.totalSupply, rpcUrl)
    ]);

    return {
        address: tokenAddress,
        name: decodeString(nameHex),
        symbol: decodeString(symbolHex),
        decimals: decodeInt(decimalsHex),
        totalSupply: decodeBigInt(supplyHex).toString()
    };
}

// Get Token balance of address
export async function getTokenBalance(tokenAddress: string, walletAddress: string, rpcUrl: string = DEFAULT_RPC): Promise<string> {
    // balanceOf signature parameter padding (address to 32 bytes)
    const cleanAddr = walletAddress.startsWith('0x') ? walletAddress.slice(2) : walletAddress;
    const data = SELECTORS.balanceOf + cleanAddr.padStart(64, '0');
    const hex = await quaiCall(tokenAddress, data, rpcUrl);
    return decodeBigInt(hex).toString();
}

// Get Quai (Native Gas Token) balance of address
export async function getQuaiBalance(walletAddress: string, rpcUrl: string = DEFAULT_RPC): Promise<string> {
    const hex = await quaiRpcCall('quai_getBalance', [walletAddress, 'latest'], rpcUrl);
    return decodeBigInt(hex).toString();
}

// Fetch LP Reserves
export async function getLPReserves(lpAddress: string, rpcUrl: string = DEFAULT_RPC): Promise<LPReserves> {
    const [token0Hex, token1Hex, reservesHex] = await Promise.all([
        quaiCall(lpAddress, SELECTORS.token0, rpcUrl),
        quaiCall(lpAddress, SELECTORS.token1, rpcUrl),
        quaiCall(lpAddress, SELECTORS.getReserves, rpcUrl)
    ]);

    const token0 = '0x' + token0Hex.slice(2).slice(-40);
    const token1 = '0x' + token1Hex.slice(2).slice(-40);
    
    const cleanRes = reservesHex.startsWith('0x') ? reservesHex.slice(2) : reservesHex;
    const reserve0 = decodeBigInt(cleanRes.slice(0, 64)).toString();
    const reserve1 = decodeBigInt(cleanRes.slice(64, 128)).toString();
    const blockTime = parseInt(cleanRes.slice(128, 192), 16);

    return {
        reserve0,
        reserve1,
        blockTime,
        token0,
        token1
    };
}

// Fetch Block Number
export async function getLatestBlockNumber(rpcUrl: string = DEFAULT_RPC): Promise<number> {
    const hex = await quaiRpcCall('quai_blockNumber', [], rpcUrl);
    return parseInt(hex, 16);
}

// Fetch raw transfers from explorer
export async function getTokenTransfers(tokenAddress: string, explorerUrl: string = DEFAULT_EXPLORER): Promise<TransferEvent[]> {
    const res = await fetch(`${explorerUrl}/api/v2/tokens/${tokenAddress}/transfers`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) {
        throw new Error(`Explorer API failed: ${res.statusText}`);
    }
    const data = await res.json();
    if (!data.items) return [];

    return data.items.map((item: any) => ({
        tx_hash: item.tx_hash,
        timestamp: item.timestamp,
        from: item.from?.hash || '',
        to: item.to?.hash || '',
        value: item.total?.value || '0',
        block_number: item.block_number || 0
    }));
}

// Fetch general stats from Quaiscan (Holders count)
export async function getHolderCount(tokenAddress: string, explorerUrl: string = DEFAULT_EXPLORER): Promise<number> {
    const res = await fetch(`${explorerUrl}/api/v2/tokens/${tokenAddress}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.holders ? parseInt(data.holders) : 0;
}

// Constant Product AMM Swapping simulation (x * y = k)
// Slippage is input as percentage e.g. 0.5 (for 0.5%)
export function simulateSwap(
    amountInStr: string,
    reserveInStr: string,
    reserveOutStr: string,
    slippagePct: number = 0.5
): SwapSimulation {
    const amountIn = BigInt(amountInStr);
    const reserveIn = BigInt(reserveInStr);
    const reserveOut = BigInt(reserveOutStr);

    if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
        return {
            amountIn: amountInStr,
            amountOut: '0',
            priceImpact: '0',
            minimumReceived: '0',
            executionPrice: '0'
        };
    }

    // Uniswap V2 formula with 0.3% fee:
    // amountOut = (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee)
    const amountInWithFee = amountIn * 997n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = (reserveIn * 1000n) + amountInWithFee;
    const amountOut = numerator / denominator;

    // Spot Price = reserveOut / reserveIn
    const spotPrice = Number(reserveOut) / Number(reserveIn);

    // Execution Price = amountOut / amountIn
    const executionPrice = Number(amountOut) / Number(amountIn);

    // Price Impact = 1 - (executionPrice / spotPrice)
    const priceImpactVal = (1 - (executionPrice / spotPrice)) * 100;
    const priceImpact = priceImpactVal.toFixed(2);

    // Minimum received = amountOut * (100 - slippage) / 100
    const slippageFactor = 10000n - BigInt(Math.floor(slippagePct * 100));
    const minimumReceived = (amountOut * slippageFactor) / 10000n;

    return {
        amountIn: amountInStr,
        amountOut: amountOut.toString(),
        priceImpact: priceImpact + '%',
        minimumReceived: minimumReceived.toString(),
        executionPrice: executionPrice.toFixed(6)
    };
}

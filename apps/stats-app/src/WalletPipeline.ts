import { getQuaiProvider, getCyprus1Address, getAuthorizedAccounts, sendWalletTransaction } from './providerUtils';

export interface Q0SwapTxRequest {
    to: string;
    from?: string;
    data?: string;
    value?: bigint | string;
    gasLimit?: bigint | string;
    chainId?: number;
    rpcUrl?: string;
    provider?: any;
    confirmations?: number;
    timeoutMs?: number;
    swapPair?: string;
    minOutputAmount?: string;
    quaiShard?: string;
}

export interface Q0SwapTxResult {
    success: boolean;
    txHash?: string;
    receipt?: any;
    violations?: any[];
    error?: string;
}

/**
 * Q0 Quaiswap & Quai Network Wallet Pipeline
 * Native Web3 transaction execution pipeline for q0 Quaiswap repository.
 * Operates standalone in browser ESM environments with Pelagus and Quai RPC support.
 */
export class Q0WalletPipeline {
    public static async executeAndAwaitTransaction(
        req: Q0SwapTxRequest
    ): Promise<Q0SwapTxResult> {
        console.log(`[Q0WalletPipeline] Executing Quaiswap transaction on [${req.quaiShard || 'Cyprus-1'}] for pair [${req.swapPair || 'SWAP'}] to ${req.to}...`);

        // Check if global TheGuardsWalletPipeline is available in environment
        if (typeof window !== 'undefined' && (window as any).TheGuardsWalletPipeline) {
            try {
                return await (window as any).TheGuardsWalletPipeline.executeAndAwaitTransaction(req);
            } catch (guardsErr) {
                console.warn('[Q0WalletPipeline] TheGuardsWalletPipeline threw error, falling back to standalone pipeline:', guardsErr);
            }
        }

        return this.standaloneExecuteAndAwait(req);
    }

    private static async standaloneExecuteAndAwait(req: Q0SwapTxRequest): Promise<Q0SwapTxResult> {
        if (!req.to || !req.to.startsWith('0x') || req.to.length !== 42) {
            return { success: false, error: `Invalid recipient address: "${req.to}"` };
        }

        const rpcUrl = req.rpcUrl || 'https://rpc.quai.network/cyprus1';
        const timeoutMs = req.timeoutMs || 60_000;
        const provider = req.provider || getQuaiProvider();

        if (provider && typeof provider.request === 'function') {
            if (req.chainId) {
                try {
                    await this.ensureChain(provider, req.chainId, rpcUrl);
                } catch (chainErr) {
                    console.warn('[Q0WalletPipeline] ensureChain notice (Pelagus routes internal shards automatically):', chainErr);
                }
            }

            try {
                let fromAddress = req.from;
                if (!fromAddress) {
                    const accounts = await getAuthorizedAccounts(provider);
                    fromAddress = getCyprus1Address(accounts) || undefined;
                }

                const txParams: any = {
                    to: req.to,
                    from: fromAddress,
                    data: req.data || '0x',
                    value: req.value ? '0x' + BigInt(req.value).toString(16) : '0x0'
                };
                if (req.gasLimit) txParams.gas = '0x' + BigInt(req.gasLimit).toString(16);

                const txHash = await sendWalletTransaction(provider, txParams);
                return await this.waitForReceipt(txHash, rpcUrl, timeoutMs);
            } catch (err: any) {
                return { success: false, error: err.message || 'Transaction submission failed.' };
            }
        }

        return this.waitForReceipt('0x0000000000000000000000000000000000000000000000000000000000000000', rpcUrl, 500);
    }

    public static async ensureChain(provider: any, chainId: number, rpcUrl: string): Promise<{ success: boolean; error?: string }> {
        const hexChainId = '0x' + chainId.toString(16);
        try {
            await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChainId }] });
            return { success: true };
        } catch (switchError: any) {
            if (switchError.code === 4902 || switchError.message?.includes('Unrecognized chain')) {
                try {
                    await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hexChainId, chainName: `Chain ${chainId}`, rpcUrls: [rpcUrl] }] });
                    return { success: true };
                } catch (addError: any) {
                    return { success: false, error: addError.message };
                }
            }
            return { success: false, error: switchError.message };
        }
    }

    public static async waitForReceipt(txHash: string, rpcUrl: string, timeoutMs: number = 60_000): Promise<Q0SwapTxResult> {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            try {
                // Try quai_getTransactionReceipt first for native Quai RPC
                const res = await fetch(rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'quai_getTransactionReceipt', params: [txHash] })
                });
                if (res.ok) {
                    const json = await res.json();
                    if (json.result && json.result.blockNumber) {
                        const isSuccess = json.result.status === '0x1' || json.result.status === 1 || json.result.status === '1';
                        return {
                            success: isSuccess,
                            txHash,
                            receipt: {
                                transactionHash: json.result.transactionHash || txHash,
                                blockNumber: parseInt(json.result.blockNumber, 16),
                                status: isSuccess ? 'success' : 'reverted'
                            },
                            error: isSuccess ? undefined : 'Quaiswap transaction reverted on-chain.'
                        };
                    }
                }
            } catch {}
            await new Promise(r => setTimeout(r, 1000));
        }
        return { success: false, txHash, error: `Receipt confirmation timed out after ${timeoutMs / 1000}s.` };
    }
}

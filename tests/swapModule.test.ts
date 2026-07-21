import { describe, test, expect } from 'bun:test';
import { Q0SwapModule, Q0_QUAISWAP_PAIRS } from '../apps/stats-app/src/SwapModule';
import { Q0WalletPipeline } from '../apps/stats-app/src/WalletPipeline';

describe('Q0 Quaiswap Quai Network Swap Subsystem', () => {
    test('Calculates constant-product AMM quote for Q0 / WQUAI LP on Cyprus-1', () => {
        const module = new Q0SwapModule();
        const quote = module.calculateQuote({
            fromToken: 'Q0',
            toToken: 'WQUAI',
            fromAmount: '100',
            shard: 'Cyprus-1'
        });

        expect(quote.fromToken).toBe('Q0');
        expect(quote.toToken).toBe('WQUAI');
        expect(parseFloat(quote.toAmount)).toBeGreaterThan(0);
        expect(quote.pairAddress).toBe(Q0_QUAISWAP_PAIRS['Q0/WQUAI']);
        expect(quote.feeAmount).toBe('0.300000'); // 0.3% fee on 100 Q0
        expect(quote.shard).toBe('Cyprus-1');
    });

    test('Executes Quaiswap LP swap via provider on Quai Network Cyprus-1 and awaits receipt', async () => {
        const module = new Q0SwapModule();
        const quote = module.calculateQuote({
            fromToken: 'WQUAI',
            toToken: 'Q0',
            fromAmount: '10',
            shard: 'Cyprus-1'
        });

        let broadcastData: any = null;
        const mockProvider = {
            request: async ({ method, params }: { method: string; params: any[] }) => {
                if (method === 'eth_accounts') return ['0x003B4b96bF0793EB1D53B79f8c38746A298eEef8'];
                if (method === 'eth_sendTransaction') {
                    broadcastData = params[0];
                    return '0x9999888877776666555544443333222211110000111122223333444455556666';
                }
                return null;
            }
        };

        const result = await module.executeSwap(quote, '0x003B4b96bF0793EB1D53B79f8c38746A298eEef8', {
            provider: mockProvider,
            timeoutMs: 400
        });

        expect(broadcastData).not.toBeNull();
        expect(broadcastData.to).toBe(Q0_QUAISWAP_PAIRS['Q0/WQUAI']);
        expect(result.txHash).toBe('0x9999888877776666555544443333222211110000111122223333444455556666');
    });

    test('Validates parameters in Q0WalletPipeline', async () => {
        const invalidRes = await Q0WalletPipeline.executeAndAwaitTransaction({
            to: 'invalid-address'
        });
        expect(invalidRes.success).toBe(false);
        expect(invalidRes.error).toBeDefined();
    });
});

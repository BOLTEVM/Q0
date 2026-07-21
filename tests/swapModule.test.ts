import { describe, test, expect } from 'bun:test';
import { Q0SwapModule } from '../apps/stats-app/src/SwapModule';
import { Q0WalletPipeline } from '../apps/stats-app/src/WalletPipeline';

describe('Q0 Layer 0 Swap Module & Pipeline Subsystem', () => {
    test('Calculates optimal cross-chain swap quote parameters', () => {
        const module = new Q0SwapModule('0x5FbDB2315678afecb367f032d93F642f64180aa3');
        const quote = module.calculateQuote({
            fromToken: 'Q0',
            toToken: 'NATIVE',
            fromAmount: '100'
        });

        expect(quote.fromToken).toBe('Q0');
        expect(quote.toToken).toBe('NATIVE');
        expect(quote.toAmount).toBe('125.000000');
        expect(quote.routerAddress).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3');
        expect(quote.priceImpactPercent).toBeLessThan(1.0);
    });

    test('Executes cross-chain swap via provider and awaits block receipt confirmation', async () => {
        const module = new Q0SwapModule('0x5FbDB2315678afecb367f032d93F642f64180aa3');
        const quote = module.calculateQuote({
            fromToken: 'NATIVE',
            toToken: 'Q0',
            fromAmount: '2'
        });

        let broadcastData: any = null;
        const mockProvider = {
            request: async ({ method, params }: { method: string; params: any[] }) => {
                if (method === 'eth_accounts') return ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'];
                if (method === 'eth_sendTransaction') {
                    broadcastData = params[0];
                    return '0x9999888877776666555544443333222211110000111122223333444455556666';
                }
                return null;
            }
        };

        const result = await module.executeSwap(quote, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', {
            provider: mockProvider,
            timeoutMs: 400
        });

        expect(broadcastData).not.toBeNull();
        expect(broadcastData.to).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3');
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

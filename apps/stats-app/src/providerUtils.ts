/**
 * Quai Network & Pelagus Provider Resolution and Transaction Helpers
 */

/**
 * Resolves the active Quai Network provider, prioritizing Pelagus and filtering multi-provider collisions.
 */
export function getQuaiProvider(): any | null {
  if (typeof window === 'undefined') return null;

  // 1. Dedicated Pelagus injected provider
  if (window.pelagus) {
    return window.pelagus;
  }

  // 2. Dedicated Quai injected provider
  if (window.quai) {
    return window.quai;
  }

  // 3. Multi-wallet provider arrays (e.g. EIP-6963 or window.ethereum.providers)
  const eth = window.ethereum as any;
  if (eth?.providers && Array.isArray(eth.providers)) {
    const pelagusProvider = eth.providers.find((p: any) => p.isPelagus || p.isQuai);
    if (pelagusProvider) {
      return pelagusProvider;
    }
  }

  // 4. Window.ethereum itself identified as Pelagus / Quai
  if (eth?.isPelagus || eth?.isQuai) {
    return eth;
  }

  // 5. Fallback to window.ethereum if no specific Pelagus provider was isolated
  if (eth) {
    return eth;
  }

  return null;
}

/**
 * Filters an accounts array to find a Cyprus-1 shard address (prefixed with 0x00).
 * Quai Network assigns shard addresses deterministically based on byte prefixes.
 */
export function getCyprus1Address(accounts: string[]): string | null {
  if (!accounts || accounts.length === 0) return null;
  const cyprus1 = accounts.find(addr => addr && addr.toLowerCase().startsWith('0x00'));
  return cyprus1 || accounts[0];
}

/**
 * Requests accounts from the provider, trying the native Quai RPC method first.
 */
export async function requestWalletAccounts(provider: any): Promise<string[]> {
  if (!provider || typeof provider.request !== 'function') {
    throw new Error('No compatible Quai / Pelagus provider available.');
  }

  try {
    return await provider.request({ method: 'quai_requestAccounts' });
  } catch (quaiErr: any) {
    // If user explicitly rejected the request, don't fall back
    if (quaiErr?.code === 4001 || quaiErr?.message?.includes('User rejected')) {
      throw quaiErr;
    }
    // Fallback to standard EVM method
    return await provider.request({ method: 'eth_requestAccounts' });
  }
}

/**
 * Silently reads already-authorized accounts from the provider without prompting the user.
 */
export async function getAuthorizedAccounts(provider: any): Promise<string[]> {
  if (!provider || typeof provider.request !== 'function') return [];

  try {
    return await provider.request({ method: 'quai_accounts' });
  } catch {
    try {
      return await provider.request({ method: 'eth_accounts' });
    } catch {
      return [];
    }
  }
}

/**
 * Submits a transaction to Quai Network, attempting quai_sendTransaction first before eth_sendTransaction.
 */
export async function sendWalletTransaction(provider: any, txParams: any): Promise<string> {
  if (!provider || typeof provider.request !== 'function') {
    throw new Error('Provider does not support RPC requests.');
  }

  try {
    return await provider.request({
      method: 'quai_sendTransaction',
      params: [txParams]
    });
  } catch (err: any) {
    // Check if error indicates quai_sendTransaction is not supported
    const isMethodNotFound =
      err?.code === -32601 ||
      err?.message?.includes('Method not found') ||
      err?.message?.includes('does not exist');

    if (isMethodNotFound) {
      return await provider.request({
        method: 'eth_sendTransaction',
        params: [txParams]
      });
    }
    throw err;
  }
}

import type { TokenInfo } from 'quai-service';

export const IMPORTED_TOKENS_KEY = 'circleswap.imported-tokens.v1';

/** Quai Cyprus-1 contract addresses start with the 0x00 shard prefix. */
export function isCyprus1ContractAddress(value: string): boolean {
  return /^0x00[0-9a-fA-F]{38}$/.test(value.trim());
}

export function normalizeContractAddress(value: string): string {
  const trimmed = value.trim();
  if (!isCyprus1ContractAddress(trimmed)) throw new Error('Enter a valid Cyprus-1 contract address beginning with 0x00.');
  return '0x' + trimmed.slice(2).toLowerCase();
}

export function readImportedTokens(): TokenInfo[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(IMPORTED_TOKENS_KEY);
    if (!raw) return [];
    const values = JSON.parse(raw) as unknown;
    if (!Array.isArray(values)) return [];
    return values.filter((token): token is TokenInfo => {
      return Boolean(
        token &&
        typeof token === 'object' &&
        typeof (token as TokenInfo).symbol === 'string' &&
        typeof (token as TokenInfo).address === 'string' &&
        isCyprus1ContractAddress((token as TokenInfo).address)
      );
    });
  } catch {
    return [];
  }
}

export function writeImportedTokens(tokens: TokenInfo[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(IMPORTED_TOKENS_KEY, JSON.stringify(tokens));
  } catch {
    // Private browsing or storage quotas should not prevent a one-session import.
  }
}

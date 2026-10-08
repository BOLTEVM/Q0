import { useEffect, useState } from 'react';
import type { TokenInfo, TokenMetadata } from 'quai-service';

export interface TokenBubbleMetadata extends TokenMetadata {
  iconUrl?: string;
  website?: string;
  description?: string;
}

interface Props {
  token: TokenInfo;
  metadata?: TokenBubbleMetadata;
  size?: 'xs' | 'sm' | 'md';
  showDetails?: boolean;
}

const avatarColors = ['#ff3344', '#00c2ff', '#8a2be2', '#10b981', '#f59e0b', '#ec4899'];

function avatarColor(symbol: string): string {
  let hash = 0;
  for (const char of symbol) hash = (hash * 31 + char.charCodeAt(0)) % avatarColors.length;
  return avatarColors[hash];
}

function safeIconUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (raw.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${raw.slice('ipfs://'.length)}`;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('data:image/')) return raw;
  try {
    const parsed = new URL(raw, typeof window === 'undefined' ? 'https://circleswap.invalid' : window.location.origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export default function TokenBubble({ token, metadata, size = 'md', showDetails = false }: Props) {
  const symbol = metadata?.symbol || token.symbol;
  const name = metadata?.name || token.name;
  const decimals = metadata?.decimals ?? token.decimals;
  const contract = token.isNative ? 'Native Cyprus-1 asset' : token.address;
  const title = `${symbol} · ${name}\n${decimals} decimals\n${contract}`;
  const iconUrl = safeIconUrl(metadata?.iconUrl || token.iconUrl);
  const [iconFailed, setIconFailed] = useState(false);

  useEffect(() => {
    setIconFailed(false);
  }, [iconUrl]);

  return (
    <span className={`token-bubble token-bubble-${size}`} title={title} aria-label={title}>
      <span className={`token-avatar token-avatar-${size}`} style={{ background: avatarColor(symbol) }}>
        <span className="token-avatar-fallback" aria-hidden="true">{symbol.slice(0, 1)}</span>
        {iconUrl && !iconFailed && <img src={iconUrl} alt="" onError={() => setIconFailed(true)} />}
      </span>
      {showDetails && (
        <span className="token-bubble-copy">
          <strong>{symbol}</strong>
          <small>{name}</small>
        </span>
      )}
    </span>
  );
}

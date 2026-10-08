import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Plus, Search } from 'lucide-react';
import type { TokenInfo } from 'quai-service';
import TokenBubble, { type TokenBubbleMetadata } from './TokenBubble';

interface Props {
  value: string;
  tokens: TokenInfo[];
  balance?: string;
  metadata?: Record<string, TokenBubbleMetadata>;
  metadataStatus?: 'loading' | 'ready' | 'partial' | 'failed';
  onChange: (symbol: string) => void;
  onImport: () => void;
}

export default function TokenPicker({ value, tokens, balance, metadata, metadataStatus, onChange, onImport }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = tokens.find(token => token.symbol === value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tokens
      .filter(token => {
        const live = metadata?.[token.address.toLowerCase()];
        return !needle
          || (live?.symbol ?? token.symbol).toLowerCase().includes(needle)
          || (live?.name ?? token.name).toLowerCase().includes(needle)
          || token.address.toLowerCase().includes(needle);
      })
      .slice(0, 80);
  }, [metadata, query, tokens]);

  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 0);
    else setQuery('');
  }, [open]);

  const choose = (symbol: string) => {
    onChange(symbol);
    setOpen(false);
  };

  return (
    <>
      <button type="button" className="token-picker-trigger" onClick={() => setOpen(true)} aria-label={`Choose token, currently ${selected?.symbol ?? value}`}>
        {selected ? <TokenBubble token={selected} metadata={metadata?.[selected.address.toLowerCase()]} showDetails /> : <span className="token-avatar">{value.slice(0, 1)}</span>}
        {!selected && <span className="token-picker-symbol">{value}</span>}
        <ChevronDown size={17} />
      </button>

      {open && (
        <div className="token-picker-backdrop" onMouseDown={() => setOpen(false)}>
          <div className="token-picker-modal" role="dialog" aria-modal="true" aria-label="Select a token" onMouseDown={event => event.stopPropagation()}>
            <div className="token-picker-modal-header">
              <strong>Select a token</strong>
              <button type="button" className="token-picker-close" onClick={() => setOpen(false)} aria-label="Close token selector">×</button>
            </div>
            <div className="token-picker-search">
              <Search size={16} />
              <input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search name or paste address" />
            </div>
            {metadataStatus === 'loading' && <div className="token-picker-metadata-status">Reading contract metadata…</div>}
            {metadataStatus === 'partial' && <div className="token-picker-metadata-status warn">Some contract metadata is unavailable; registry values are shown.</div>}
            {metadataStatus === 'failed' && <div className="token-picker-metadata-status warn">Live metadata is unavailable; registry values are shown.</div>}
            <div className="token-picker-list">
              {filtered.map(token => (
                <button key={token.address.toLowerCase()} type="button" className={`token-picker-option ${token.symbol === value ? 'selected' : ''}`} onClick={() => choose(token.symbol)}>
                  <TokenBubble token={token} metadata={metadata?.[token.address.toLowerCase()]} showDetails />
                  <span className="token-picker-option-balance">{token.symbol === value && balance ? balance : ''}</span>
                </button>
              ))}
              {filtered.length === 0 && <div className="token-picker-empty">No token matches this search.</div>}
            </div>
            <button type="button" className="token-picker-import" onClick={() => { setOpen(false); onImport(); }}>
              <Plus size={16} /> Import a token
            </button>
            <p className="token-picker-warning">Anyone can create a token. Verify the contract address before trading.</p>
          </div>
        </div>
      )}
    </>
  );
}

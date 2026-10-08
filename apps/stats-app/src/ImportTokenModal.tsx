import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Search, ShieldCheck } from 'lucide-react';
import { getTokenMetadata, type TokenInfo } from 'quai-service';
import { Field, Modal, Notice, input, smallBtn } from './ui';
import { normalizeContractAddress } from './customTokens';

interface Props {
  onClose: () => void;
  onImported: (token: TokenInfo) => void;
}

export default function ImportTokenModal({ onClose, onImported }: Props) {
  const [address, setAddress] = useState('');
  const [metadata, setMetadata] = useState<TokenInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = async () => {
    setError(null);
    setMetadata(null);
    let normalized: string;
    try {
      normalized = normalizeContractAddress(address);
    } catch (e: any) {
      setError(e.message);
      return;
    }
    setLoading(true);
    try {
      const chainToken = await getTokenMetadata(normalized);
      if (!chainToken.symbol.trim()) throw new Error('This contract did not return an ERC-20 symbol.');
      if (chainToken.decimals < 0 || chainToken.decimals > 36) throw new Error('The token reported unsupported decimals.');
      const symbol = chainToken.symbol.trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(symbol)) throw new Error('The token symbol contains unsupported characters.');
      setMetadata({
        symbol,
        name: chainToken.name.trim() || symbol,
        decimals: chainToken.decimals,
        address: normalized,
        deployed: true,
        description: 'Imported from Cyprus-1'
      });
    } catch (e: any) {
      setError(e?.message || 'Could not read ERC-20 metadata from Cyprus-1.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Import token" icon={<ShieldCheck size={18} style={{ color: 'var(--accent-neon)' }} />} onClose={onClose} maxWidth={470}>
      <Notice tone="warn">
        <strong>Import with care.</strong> Anyone can deploy a token with a familiar name or ticker. Only trade a contract you have verified.
      </Notice>
      <Field label="Token contract" hint="Cyprus-1 addresses begin with 0x00.">
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input style={{ ...input, flex: 1, fontFamily: 'monospace' }} value={address} onChange={event => setAddress(event.target.value)} placeholder="0x00…" onKeyDown={event => { if (event.key === 'Enter') lookup(); }} />
          <button type="button" style={smallBtn} onClick={lookup} disabled={loading || !address.trim()}>
            <Search size={14} /> {loading ? 'Reading…' : 'Read'}
          </button>
        </div>
      </Field>
      {error && <Notice tone="danger"><AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} />{error}</Notice>}
      {metadata && (
        <div className="import-token-preview">
          <div className="import-token-preview-icon">{metadata.symbol.slice(0, 1)}</div>
          <div>
            <strong>{metadata.symbol}</strong>
            <div>{metadata.name}</div>
            <small>{metadata.decimals} decimals · {metadata.address.slice(0, 10)}…{metadata.address.slice(-8)}</small>
          </div>
          <CheckCircle2 size={18} style={{ color: 'var(--success)', marginLeft: 'auto' }} />
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
        <button type="button" style={smallBtn} onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!metadata} onClick={() => metadata && onImported(metadata)}>Import token</button>
      </div>
    </Modal>
  );
}

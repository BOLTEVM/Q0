import { Layers, Droplets } from 'lucide-react';
import { DEXES, compactNumber, priceImpactTable, isDexLive, type PairAnalysis, type PairToken } from 'quai-service';
import { Modal, Badge, AddrLink, CopyButton, Notice, box, row, muted, smallBtn } from './ui';

const sym = (t: PairToken) => t.symbol || `${t.address.slice(0, 6)}…`;
const human = (raw: bigint, d: number) => Number(raw) / 10 ** d;

interface Props {
  pair: PairAnalysis;
  /** Other pools that hold the same two tokens (other DEXes, or duplicates). */
  siblings: PairAnalysis[];
  usd: number | null;
  onOpenLiquidity: () => void;
  onSelect: (pairAddress: string) => void;
  onClose: () => void;
}

export default function PairDetailModal({ pair, siblings, usd, onOpenLiquidity, onSelect, onClose }: Props) {
  const r0 = human(pair.reserve0, pair.token0.decimals);
  const r1 = human(pair.reserve1, pair.token1.decimals);
  const impact0 = priceImpactTable(r0, r1);
  const impact1 = priceImpactTable(r1, r0);
  const canAdd = pair.token0.registered && pair.token1.registered && isDexLive(pair.dex);

  return (
    <Modal title={`${sym(pair.token0)} / ${sym(pair.token1)}`} icon={<Layers size={20} style={{ color: 'var(--accent-plasma)' }} />} onClose={onClose} maxWidth={640}>
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.9rem' }}>
        <Badge severity="neutral">{DEXES[pair.dex].label}</Badge>
        {pair.isNew && <Badge severity="info">New</Badge>}
        <span style={{ ...muted, fontSize: '0.75rem' }}>pool #{pair.index} of its factory</span>
        <AddrLink address={pair.pair} />
        <CopyButton text={pair.pair} label="Copy pool" />
      </div>

      {pair.flags.length > 0 && (
        <div style={{ marginBottom: '0.9rem' }}>
          {pair.flags.map(f => (
            <Notice key={f.code + f.label} tone={f.severity === 'danger' ? 'danger' : f.severity === 'warn' ? 'warn' : 'info'}>
              <strong>{f.label}.</strong> {f.detail}
            </Notice>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.6rem', marginBottom: '1rem' }}>
        <div style={box}>
          <div style={{ ...muted, fontSize: '0.7rem', textTransform: 'uppercase' }}>Liquidity</div>
          <div style={{ fontSize: '1.15rem', fontWeight: 800 }}>{pair.tvlQuai === null ? 'Unpriced' : `${compactNumber(pair.tvlQuai)} QUAI`}</div>
          <div style={{ ...muted, fontSize: '0.75rem' }}>{pair.tvlUsd !== null ? `≈ $${compactNumber(pair.tvlUsd)}` : usd === null ? 'USD price unavailable' : 'No route to WQUAI'}</div>
        </div>
        <div style={box}>
          <div style={{ ...muted, fontSize: '0.7rem', textTransform: 'uppercase' }}>LP burned</div>
          <div style={{ fontSize: '1.15rem', fontWeight: 800 }}>{pair.totalSupply > 0n ? `${pair.burnedPct.toFixed(2)}%` : '—'}</div>
          <div style={{ ...muted, fontSize: '0.75rem' }}>of {compactNumber(human(pair.totalSupply, 18))} pool tokens</div>
        </div>
        <div style={box}>
          <div style={{ ...muted, fontSize: '0.7rem', textTransform: 'uppercase' }}>Spot price</div>
          <div style={{ fontSize: '0.9rem', fontWeight: 800 }}>1 {sym(pair.token0)} = {compactNumber(pair.spot, 6)} {sym(pair.token1)}</div>
          <div style={{ ...muted, fontSize: '0.75rem' }}>1 {sym(pair.token1)} = {compactNumber(pair.spot > 0 ? 1 / pair.spot : 0, 6)} {sym(pair.token0)}</div>
        </div>
      </div>

      <div className="table-wrapper" style={{ marginBottom: '1rem' }}>
        <table>
          <thead>
            <tr>
              <th>Token</th>
              <th>Contract</th>
              <th style={{ textAlign: 'right' }}>Reserve</th>
              <th style={{ textAlign: 'right' }}>Price (QUAI)</th>
            </tr>
          </thead>
          <tbody>
            {([
              [pair.token0, r0, pair.price0Quai],
              [pair.token1, r1, pair.price1Quai]
            ] as [PairToken, number, number | null][]).map(([t, r, price]) => (
              <tr key={t.address}>
                <td>
                  <strong>{sym(t)}</strong> {!t.registered && <Badge severity="warn">Unlisted</Badge>}
                  <div style={{ ...muted, fontSize: '0.7rem' }}>{t.name || '—'} · {t.decimals} decimals</div>
                </td>
                <td><AddrLink address={t.address} /></td>
                <td style={{ textAlign: 'right' }}>{compactNumber(r)}</td>
                <td style={{ textAlign: 'right' }}>{price === null ? '—' : compactNumber(price, 6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ fontWeight: 800, marginBottom: '0.4rem', fontFamily: 'var(--font-display)' }}>Depth: what a trade does to the price</div>
      {impact0.length === 0 ? (
        <div style={{ ...muted, fontSize: '0.85rem', marginBottom: '1rem' }}>The pool has no liquidity on one side.</div>
      ) : (
        <div className="table-wrapper" style={{ marginBottom: '0.4rem' }}>
          <table>
            <thead>
              <tr>
                <th>Trade size</th>
                <th style={{ textAlign: 'right' }}>Sell {sym(pair.token0)}</th>
                <th style={{ textAlign: 'right' }}>Price impact</th>
                <th style={{ textAlign: 'right' }}>Sell {sym(pair.token1)}</th>
                <th style={{ textAlign: 'right' }}>Price impact</th>
              </tr>
            </thead>
            <tbody>
              {impact0.map((row0, i) => (
                <tr key={row0.pctOfReserve}>
                  <td>{row0.pctOfReserve}% of reserve</td>
                  <td style={{ textAlign: 'right' }}>{compactNumber(row0.amountIn)}</td>
                  <td style={{ textAlign: 'right', color: row0.impactPct > 5 ? 'var(--error)' : row0.impactPct > 1 ? 'var(--warning)' : undefined }}>{row0.impactPct.toFixed(2)}%</td>
                  <td style={{ textAlign: 'right' }}>{compactNumber(impact1[i].amountIn)}</td>
                  <td style={{ textAlign: 'right', color: impact1[i].impactPct > 5 ? 'var(--error)' : impact1[i].impactPct > 1 ? 'var(--warning)' : undefined }}>{impact1[i].impactPct.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ ...muted, fontSize: '0.72rem', marginBottom: '1rem' }}>Constant-product maths with a 0.3% fee (the standard for these DEXes); it includes the fee, so even a tiny trade shows about 0.3%.</div>

      {siblings.length > 0 && (
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ fontWeight: 800, marginBottom: '0.4rem', fontFamily: 'var(--font-display)' }}>Same tokens elsewhere</div>
          {siblings.map(s => (
            <div key={s.pair} style={{ ...box, marginBottom: '0.4rem', cursor: 'pointer' }} onClick={() => onSelect(s.pair)} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && onSelect(s.pair)}>
              <div style={row}>
                <span><strong>{DEXES[s.dex].label}</strong> · {sym(s.token0)} / {sym(s.token1)}</span>
                <span>{s.tvlQuai === null ? 'Unpriced' : `${compactNumber(s.tvlQuai)} QUAI`}</span>
              </div>
              <div style={{ ...muted, fontSize: '0.72rem' }}>
                {s.token0.address.toLowerCase() === pair.token0.address.toLowerCase() ? `1 ${sym(s.token0)} = ${compactNumber(s.spot, 6)} ${sym(s.token1)}` : `1 ${sym(s.token1)} = ${compactNumber(s.spot > 0 ? 1 / s.spot : 0, 6)} ${sym(s.token0)}`}
                {' '}(here: {compactNumber(pair.spot, 6)})
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {canAdd ? (
          <button type="button" className="btn-primary" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', minHeight: 40 }} onClick={onOpenLiquidity}>
            <Droplets size={16} /> Add liquidity
          </button>
        ) : (
          <span style={{ ...muted, fontSize: '0.78rem', alignSelf: 'center' }}>
            {!isDexLive(pair.dex) ? 'This DEX is not deployed.' : 'Liquidity can be added in-app only for pairs of listed tokens.'}
          </span>
        )}
        <a style={{ ...smallBtn, textDecoration: 'none' }} href={`https://quaiscan.io/address/${pair.pair}`} target="_blank" rel="noreferrer">View on explorer</a>
      </div>
    </Modal>
  );
}

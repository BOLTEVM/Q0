import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, Sparkles, CalendarClock, ShieldAlert, Layers } from 'lucide-react';
import {
  DEXES,
  DEX_IDS,
  isDexLive,
  loadPairSnapshots,
  scanAllCreations,
  applyCreations,
  analyzePairs,
  sortPairs,
  fetchQuaiUsd,
  compactNumber,
  type DexId,
  type PairAnalysis,
  type PairSnapshot,
  type PairSortKey,
  type PairToken,
  type LoadResult,
  type CreationScan
} from 'quai-service';
import PairDetailModal from './PairDetailModal';
import { Badge, Spinner, muted, select, smallBtn, input, box } from './ui';

/** ~8 days of zone blocks at a 5 s block time; the node allows 10,000 blocks per log query. */
const SCAN_LOOKBACK_BLOCKS = 150_000;
const PAGE = 60;
const REFRESH_MS = 90_000;

const DEX_COLOR: Record<DexId, string> = { CIRCLESWAP: 'var(--accent-plasma)', QUAISWAP: 'var(--accent-neon)', QUAINANCE: 'var(--accent-gold)' };

const sym = (t: PairToken) => t.symbol || `${t.address.slice(0, 6)}…`;

function worst(p: PairAnalysis): 'danger' | 'warn' | 'info' | null {
  if (p.flags.some(f => f.severity === 'danger')) return 'danger';
  if (p.flags.some(f => f.severity === 'warn')) return 'warn';
  return p.flags.length ? 'info' : null;
}

function ageLabel(p: PairAnalysis, scan: CreationScan | null, nowSec: number): string {
  if (p.createdAt !== undefined) {
    const d = nowSec - p.createdAt;
    if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
    if (d < 86400) return `${Math.round(d / 3600)} h ago`;
    return `${Math.round(d / 86400)} d ago`;
  }
  return scan ? 'older' : `#${p.index}`;
}

function priceText(p: PairAnalysis): string {
  return p.spot > 0 ? `1 ${sym(p.token0)} = ${compactNumber(p.spot, 4)} ${sym(p.token1)}` : '—';
}

interface Props {
  onOpenLiquidity: () => void;
}

export default function PairsPage({ onOpenLiquidity }: Props) {
  const [data, setData] = useState<LoadResult | null>(null);
  const [scan, setScan] = useState<CreationScan | null>(null);
  const [usd, setUsd] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<number | null>(null);

  const [dexFilter, setDexFilter] = useState<Record<DexId, boolean>>({ CIRCLESWAP: true, QUAISWAP: true, QUAINANCE: true });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<PairSortKey>('tvl');
  const [onlyNew, setOnlyNew] = useState(false);
  const [hideRisky, setHideRisky] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [res, price] = await Promise.all([loadPairSnapshots(), fetchQuaiUsd()]);
      setData(res);
      setUsd(price);
      setUpdated(Date.now());
    } catch (e: any) {
      setError(e?.message ?? 'Could not load pairs.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const runScan = async () => {
    if (!data || !data.block) return;
    setScanning(true);
    setScanError(null);
    try {
      setScan(await scanAllCreations(DEX_IDS, data.block, SCAN_LOOKBACK_BLOCKS));
    } catch (e: any) {
      setScanError(e?.message ?? 'Scan failed.');
    } finally {
      setScanning(false);
    }
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const pairs: PairAnalysis[] = useMemo(() => {
    if (!data) return [];
    const snaps: PairSnapshot[] = scan ? applyCreations(data.pairs, scan.creations) : data.pairs;
    return analyzePairs(snaps, { quaiUsd: usd });
  }, [data, scan, usd]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = pairs.filter(p => {
      if (!dexFilter[p.dex]) return false;
      if (onlyNew && !p.isNew) return false;
      if (hideRisky && p.flags.some(f => f.severity === 'danger')) return false;
      if (!q) return true;
      return [p.token0.symbol, p.token1.symbol, p.token0.name, p.token1.name, p.pair, p.token0.address, p.token1.address].some(v => v.toLowerCase().includes(q));
    });
    return sortPairs(list, sort);
  }, [pairs, dexFilter, query, sort, onlyNew, hideRisky]);

  const newest = useMemo(() => sortPairs(pairs.filter(p => p.isNew), 'newest').slice(0, 8), [pairs]);

  const totals = useMemo(() => {
    const byDex: Record<string, { pools: number; tvl: number }> = {};
    let tvl = 0;
    for (const p of pairs) {
      const d = (byDex[p.dex] ??= { pools: 0, tvl: 0 });
      d.pools++;
      d.tvl += p.tvlQuai ?? 0;
      tvl += p.tvlQuai ?? 0;
    }
    return {
      byDex,
      tvl,
      risky: pairs.filter(p => p.flags.some(f => f.severity === 'danger')).length,
      unpriced: pairs.filter(p => p.tvlQuai === null).length
    };
  }, [pairs]);

  const selectedPair = selected ? pairs.find(p => p.pair.toLowerCase() === selected) ?? null : null;
  const fmtTvl = (p: PairAnalysis) => (p.tvlQuai === null ? '—' : `${compactNumber(p.tvlQuai)} QUAI`);

  return (
    <div style={{ marginBottom: '3rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
        <div className="section-title" style={{ margin: 0 }}>
          <Layers size={22} style={{ color: 'var(--accent-plasma)' }} /> All Pairs &amp; Liquidity
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {updated && <span style={{ ...muted, fontSize: '0.75rem' }}>Updated {new Date(updated).toLocaleTimeString()}</span>}
          <button type="button" style={smallBtn} onClick={runScan} disabled={scanning || loading || !data} title="Reads each factory's PairCreated events to date recent pools">
            {scanning ? <Spinner /> : <CalendarClock size={14} />} {scan ? 'Rescan creation times' : 'Find creation times'}
          </button>
          <button type="button" style={smallBtn} onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'loader' : ''} /> Refresh
          </button>
        </div>
      </div>

      {error && <div style={{ ...box, borderColor: 'var(--error)', marginBottom: '1rem' }}>Could not load pairs: {error}</div>}
      {data && data.errors.length > 0 && (
        <div style={{ ...box, borderColor: 'var(--warning)', marginBottom: '1rem', fontSize: '0.8rem' }}>
          Some data could not be read, so the list below may be incomplete:
          <ul style={{ margin: '0.3rem 0 0 1.2rem' }}>
            {data.errors.slice(0, 5).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
            {data.errors.length > 5 && <li>…and {data.errors.length - 5} more</li>}
          </ul>
        </div>
      )}
      {scanError && <div style={{ ...box, borderColor: 'var(--warning)', marginBottom: '1rem', fontSize: '0.8rem' }}>Creation-time scan failed: {scanError}</div>}

      {/* Overview */}
      <div className="stats-grid" style={{ marginBottom: '1.25rem' }}>
        <div className="glass-card stat-card">
          <div className="stat-header">Pools indexed</div>
          <div className="stat-value">{loading && !data ? <Spinner /> : pairs.length}</div>
          <div className="stat-sub">
            {DEX_IDS.map(id => (isDexLive(id) ? `${DEXES[id].label} ${data?.totals[id] ?? '…'}` : `${DEXES[id].label} not deployed`)).join(' · ')}
          </div>
        </div>
        <div className="glass-card stat-card">
          <div className="stat-header">Liquidity (estimated)</div>
          <div className="stat-value">{compactNumber(totals.tvl)} QUAI</div>
          <div className="stat-sub">{usd ? `≈ $${compactNumber(totals.tvl * usd)} at $${usd.toPrecision(3)} / QUAI` : 'USD price unavailable'}{totals.unpriced ? ` · ${totals.unpriced} pools unpriced` : ''}</div>
        </div>
        <div className="glass-card stat-card">
          <div className="stat-header">New pools</div>
          <div className="stat-value">{pairs.filter(p => p.isNew).length}</div>
          <div className="stat-sub">
            {scan ? `Dated back to ${scan.fromTime ? new Date(scan.fromTime * 1000).toLocaleDateString() : `block ${scan.fromBlock}`}` : 'Newest by factory order; find creation times for dates'}
          </div>
        </div>
        <div className="glass-card stat-card">
          <div className="stat-header">High-risk flags</div>
          <div className="stat-value" style={{ color: totals.risky ? 'var(--error)' : undefined }}>{totals.risky}</div>
          <div className="stat-sub">Empty, tiny, or imitating a listed token</div>
        </div>
      </div>

      {/* Liquidity by DEX */}
      {pairs.length > 0 && (
        <div className="glass-card" style={{ marginBottom: '1.25rem' }}>
          <div style={{ fontWeight: 800, marginBottom: '0.6rem', fontFamily: 'var(--font-display)' }}>Liquidity by DEX</div>
          {DEX_IDS.filter(id => totals.byDex[id]).map(id => {
            const d = totals.byDex[id];
            const pct = totals.tvl > 0 ? (d.tvl / totals.tvl) * 100 : 0;
            return (
              <div key={id} style={{ marginBottom: '0.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                  <span style={{ color: DEX_COLOR[id], fontWeight: 700 }}>{DEXES[id].label}</span>
                  <span style={muted}>{d.pools} pools · {compactNumber(d.tvl)} QUAI · {pct.toFixed(1)}%</span>
                </div>
                <div style={{ height: 6, borderRadius: 4, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: DEX_COLOR[id] }} />
                </div>
              </div>
            );
          })}
          {!isDexLive('CIRCLESWAP') && (
            <div style={{ fontSize: '0.78rem', ...muted, marginTop: '0.4rem' }}>
              Circleswap is not deployed yet. Its pools will appear here automatically once the factory exists (see the Deploy tab).{' '}
              <button type="button" style={{ ...smallBtn, marginLeft: '0.25rem' }} onClick={onOpenLiquidity}>Create a pool elsewhere</button>
            </div>
          )}
        </div>
      )}

      {/* New pairs */}
      <div className="glass-card" style={{ marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 800, marginBottom: '0.6rem', fontFamily: 'var(--font-display)' }}>
          <Sparkles size={16} style={{ color: 'var(--accent-gold)' }} /> New pairs
        </div>
        {newest.length === 0 ? (
          <div style={{ ...muted, fontSize: '0.85rem' }}>{loading ? 'Loading…' : 'No new pairs right now.'}</div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>DEX</th>
                  <th>Created</th>
                  <th style={{ textAlign: 'right' }}>Liquidity</th>
                  <th>Signals</th>
                </tr>
              </thead>
              <tbody>
                {newest.map(p => (
                  <tr key={p.pair} onClick={() => setSelected(p.pair.toLowerCase())} style={{ cursor: 'pointer' }}>
                    <td style={{ fontWeight: 700 }}>{sym(p.token0)} / {sym(p.token1)}</td>
                    <td style={{ color: DEX_COLOR[p.dex] }}>{DEXES[p.dex].label}</td>
                    <td>{ageLabel(p, scan, nowSec)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtTvl(p)}</td>
                    <td>
                      <span style={{ display: 'inline-flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                        {p.flags.filter(f => f.code !== 'NEW').slice(0, 3).map(f => (
                          <Badge key={f.code + f.label} severity={f.severity} title={f.detail}>{f.label}</Badge>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="glass-card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: '1 1 220px' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-muted)' }} />
            <input style={{ ...input, paddingLeft: '2rem' }} placeholder="Search symbol, name or address" value={query} onChange={e => { setQuery(e.target.value); setLimit(PAGE); }} aria-label="Search pairs" />
          </div>
          {DEX_IDS.map(id => (
            <button
              key={id}
              type="button"
              aria-pressed={dexFilter[id]}
              onClick={() => { setDexFilter(f => ({ ...f, [id]: !f[id] })); setLimit(PAGE); }}
              style={{ ...select, cursor: 'pointer', opacity: dexFilter[id] ? 1 : 0.45, borderColor: dexFilter[id] ? DEX_COLOR[id] : 'var(--panel-border)' }}
            >
              {DEXES[id].label}
            </button>
          ))}
          <select style={select} value={sort} onChange={e => setSort(e.target.value as PairSortKey)} aria-label="Sort pairs">
            <option value="tvl">Sort: liquidity</option>
            <option value="newest">Sort: newest</option>
            <option value="reserves">Sort: largest reserve</option>
            <option value="burned">Sort: LP burned</option>
          </select>
          <label style={{ fontSize: '0.8rem', display: 'flex', gap: '0.3rem', alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={onlyNew} onChange={e => setOnlyNew(e.target.checked)} /> Only new
          </label>
          <label style={{ fontSize: '0.8rem', display: 'flex', gap: '0.3rem', alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={hideRisky} onChange={e => setHideRisky(e.target.checked)} /> Hide high-risk
          </label>
        </div>
      </div>

      {/* All pairs */}
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Pair</th>
              <th>DEX</th>
              <th style={{ textAlign: 'right' }}>Liquidity</th>
              <th>Price</th>
              <th style={{ textAlign: 'right' }}>LP burned</th>
              <th>Age</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            {visible.slice(0, limit).map(p => {
              const w = worst(p);
              return (
                <tr key={p.dex + p.pair} onClick={() => setSelected(p.pair.toLowerCase())} style={{ cursor: 'pointer' }} tabIndex={0} onKeyDown={e => e.key === 'Enter' && setSelected(p.pair.toLowerCase())}>
                  <td>
                    <div style={{ fontWeight: 700 }}>
                      {sym(p.token0)} / {sym(p.token1)} {p.isNew && <Badge severity="info">New</Badge>}
                    </div>
                    <div style={{ fontSize: '0.7rem', ...muted }}>
                      {compactNumber(Number(p.reserve0) / 10 ** p.token0.decimals)} {sym(p.token0)} · {compactNumber(Number(p.reserve1) / 10 ** p.token1.decimals)} {sym(p.token1)}
                    </div>
                  </td>
                  <td style={{ color: DEX_COLOR[p.dex], fontWeight: 600 }}>{DEXES[p.dex].label}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div>{fmtTvl(p)}</div>
                    {p.tvlUsd !== null && <div style={{ fontSize: '0.7rem', ...muted }}>${compactNumber(p.tvlUsd)}</div>}
                  </td>
                  <td style={{ fontSize: '0.78rem' }}>{priceText(p)}</td>
                  <td style={{ textAlign: 'right' }}>{p.totalSupply > 0n ? `${p.burnedPct.toFixed(1)}%` : '—'}</td>
                  <td>{ageLabel(p, scan, nowSec)}</td>
                  <td>
                    {w ? (
                      <span title={p.flags.map(f => f.label).join(', ')}>
                        <Badge severity={w}>{w === 'danger' ? 'High' : w === 'warn' ? 'Caution' : 'Note'} · {p.flags.length}</Badge>
                      </span>
                    ) : (
                      <span style={muted}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', ...muted, padding: '2rem' }}>
                  {pairs.length === 0 ? 'No pools found.' : 'No pools match these filters.'}
                </td>
              </tr>
            )}
            {loading && !data && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '2rem' }}><Spinner /> Reading every factory…</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {visible.length > limit && (
        <div style={{ textAlign: 'center', marginTop: '0.75rem' }}>
          <button type="button" style={smallBtn} onClick={() => setLimit(l => l + PAGE)}>Show more ({visible.length - limit} left)</button>
        </div>
      )}
      <div style={{ ...muted, fontSize: '0.72rem', marginTop: '0.75rem', display: 'flex', gap: '0.4rem', alignItems: 'flex-start' }}>
        <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>
          Values are estimates from pool reserves: Cyprus-1 has no price oracle, a thin pool can show any price, and none of this says anything about a token&apos;s contract. Risk flags are prompts to look closer, not verdicts. Pools are read from the DEX factories ({DEX_IDS.filter(isDexLive).map(id => DEXES[id].label).join(', ')}).
        </span>
      </div>

      {selectedPair && (
        <PairDetailModal
          pair={selectedPair}
          siblings={pairs.filter(p => p.pair !== selectedPair.pair && [p.token0.address, p.token1.address].every(a => [selectedPair.token0.address, selectedPair.token1.address].some(b => b.toLowerCase() === a.toLowerCase())))}
          usd={usd}
          onOpenLiquidity={() => { setSelected(null); onOpenLiquidity(); }}
          onClose={() => setSelected(null)}
          onSelect={a => setSelected(a.toLowerCase())}
        />
      )}
    </div>
  );
}

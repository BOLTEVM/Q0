import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ArrowDownUp, Database, ExternalLink, RefreshCw } from 'lucide-react';
import {
  CONTRACTS,
  DEPLOYED,
  TOKEN_REGISTRY,
  formatUnits,
  getTokenDetailV2,
  type DexId,
  type LPReserves,
  type PoolInfo,
  type TokenDetailV2,
  type TokenTransferV2
} from 'quai-service';
import { readLocalDeployments } from 'quai-service/bootstrap';

type TokenSymbol = 'Q0' | 'BDELTA' | 'QRB';
type TokenRecord = {
  symbol: TokenSymbol;
  address: string | null;
  name: string;
  color: string;
};

// Analytics-only fallback supplied for the deployed QRB contract. Keep it out of the
// generated deployment registry until the normal on-chain runtime verification is recorded.
const QRB_ANALYTICS_ADDRESS = '0x0050a7fcb00521b75bb5f3bc8e1d49fed7c08ce5';

const tokenRecords: TokenRecord[] = [
  { symbol: 'Q0', address: CONTRACTS.Q0, name: 'QBOLT', color: '#00d7e8' },
  { symbol: 'BDELTA', address: CONTRACTS.BDELTA, name: 'BoltDelta', color: '#9b63ff' },
  { symbol: 'QRB', address: DEPLOYED.QRB ?? readLocalDeployments()?.values.QRB ?? QRB_ANALYTICS_ADDRESS, name: 'Circleswap Qrb', color: '#ffb321' }
];

const tokenOrder: TokenSymbol[] = ['Q0', 'BDELTA', 'QRB'];
const tokenLabel = (symbol: string) => TOKEN_REGISTRY[symbol]?.symbol ?? symbol;

function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

function formatUsd(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Number(value))) return '—';
  const amount = Number(value);
  return amount < 0.01 ? `$${amount.toPrecision(4)}` : `$${amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

function displayAmount(raw: string, decimals: number, precision = 4): string {
  try {
    const value = Number(formatUnits(raw, decimals, precision));
    return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: precision }) : '—';
  } catch {
    return '—';
  }
}

function shortAddress(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function timeLabel(timestamp: string): string {
  const numeric = Number(timestamp);
  const date = new Date(Number.isFinite(numeric) && numeric > 0 ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : timestamp);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function changeLabel(raw: string | null | undefined): string {
  if (!raw || !Number.isFinite(Number(raw))) return '—';
  const value = Number(raw);
  return `${value > 0 ? '+' : ''}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function pairRateFromUsd(details: Partial<Record<TokenSymbol, TokenDetailV2>>, from: TokenSymbol, to: TokenSymbol): number | null {
  const fromUsd = Number(details[from]?.marketStats?.priceUsd);
  const toUsd = Number(details[to]?.marketStats?.priceUsd);
  return fromUsd > 0 && toUsd > 0 ? fromUsd / toUsd : null;
}

function addressForToken(symbol: string): string | undefined {
  if (symbol === 'QRB') return tokenRecords.find(token => token.symbol === 'QRB')?.address ?? undefined;
  return TOKEN_REGISTRY[symbol]?.address;
}

function reserveForToken(reserves: LPReserves, symbol: string): string {
  const address = addressForToken(symbol)?.toLowerCase();
  if (!address) return '0';
  if (reserves.token0.toLowerCase() === address) return reserves.reserve0;
  if (reserves.token1.toLowerCase() === address) return reserves.reserve1;
  return '0';
}

interface Props {
  latestBlock: number;
  pools: PoolInfo[];
  poolReserves: Record<string, LPReserves>;
}

export default function TokenAnalyticsPage({ latestBlock, pools, poolReserves }: Props) {
  const [details, setDetails] = useState<Partial<Record<TokenSymbol, TokenDetailV2>>>({});
  const [failures, setFailures] = useState<Partial<Record<TokenSymbol, string>>>({});
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [holderToken, setHolderToken] = useState<TokenSymbol>('Q0');
  const [ledgerToken, setLedgerToken] = useState<'ALL' | TokenSymbol>('ALL');
  const [section, setSection] = useState('analytics-overview');

  useEffect(() => {
    let live = true;
    setLoading(true);
    const available = tokenRecords.filter((token): token is TokenRecord & { address: string } => Boolean(token.address));
    const missingQrb = tokenRecords.find(token => token.symbol === 'QRB' && !token.address);
    Promise.all(available.map(async token => {
      try {
        return [token.symbol, await getTokenDetailV2(token.address)] as const;
      } catch (error) {
        return [token.symbol, error instanceof Error ? error.message : 'Explorer data is unavailable'] as const;
      }
    })).then(results => {
      if (!live) return;
      const nextDetails: Partial<Record<TokenSymbol, TokenDetailV2>> = {};
      const nextFailures: Partial<Record<TokenSymbol, string>> = {};
      for (const [symbol, result] of results) {
        if (typeof result === 'string') nextFailures[symbol] = result;
        else nextDetails[symbol] = result;
      }
      if (missingQrb) nextFailures.QRB = 'QRB deployment address is not recorded for this browser or build.';
      setDetails(nextDetails);
      setFailures(nextFailures);
      setLoading(false);
    });
    return () => { live = false; };
  }, [refreshKey]);

  const transfers = useMemo(() => tokenOrder.flatMap(symbol => {
    const detail = details[symbol];
    if (!detail) return [];
    return detail.transfers.map(transfer => ({ ...transfer, analyticsSymbol: symbol }));
  }).sort((a, b) => {
    const aTime = Number(a.timestamp);
    const bTime = Number(b.timestamp);
    const aMs = Number.isFinite(aTime) ? (aTime < 10_000_000_000 ? aTime * 1000 : aTime) : Date.parse(a.timestamp);
    const bMs = Number.isFinite(bTime) ? (bTime < 10_000_000_000 ? bTime * 1000 : bTime) : Date.parse(b.timestamp);
    return bMs - aMs;
  }), [details]);

  const trackedPairs = useMemo(() => {
    const graph = new Map<string, Array<{ to: string; rate: number }>>();
    for (const pool of pools) {
      const reserve = poolReserves[pool.pair.toLowerCase()];
      if (!reserve) continue;
      const [symbol0, symbol1] = pool.tokens;
      const token0 = TOKEN_REGISTRY[symbol0];
      const token1 = TOKEN_REGISTRY[symbol1];
      const reserve0 = reserveForToken(reserve, symbol0);
      const reserve1 = reserveForToken(reserve, symbol1);
      const amount0 = Number(displayAmount(reserve0, token0?.decimals ?? 18, 8).replace(/,/g, ''));
      const amount1 = Number(displayAmount(reserve1, token1?.decimals ?? 18, 8).replace(/,/g, ''));
      if (!(amount0 > 0 && amount1 > 0)) continue;
      const add = (from: string, to: string, rate: number) => graph.set(from, [...(graph.get(from) ?? []), { to, rate }]);
      add(symbol0, symbol1, amount1 / amount0);
      add(symbol1, symbol0, amount0 / amount1);
    }

    const findRate = (from: string, to: string): { rate: number; path: string[] } | null => {
      const queue: Array<{ symbol: string; rate: number; path: string[] }> = [{ symbol: from, rate: 1, path: [from] }];
      while (queue.length) {
        const current = queue.shift()!;
        if (current.symbol === to) return { rate: current.rate, path: current.path };
        if (current.path.length >= 5) continue;
        for (const edge of graph.get(current.symbol) ?? []) {
          if (current.path.includes(edge.to)) continue;
          queue.push({ symbol: edge.to, rate: current.rate * edge.rate, path: [...current.path, edge.to] });
        }
      }
      return null;
    };

    return [
      ['Q0', 'BDELTA'],
      ['Q0', 'QRB'],
      ['BDELTA', 'QRB']
    ].map(([from, to]) => ({
      from: from as TokenSymbol,
      to: to as TokenSymbol,
      usdRate: pairRateFromUsd(details, from as TokenSymbol, to as TokenSymbol),
      amm: findRate(from, to)
    }));
  }, [details, poolReserves, pools]);

  const relevantPools = useMemo(() => pools.filter(pool => pool.tokens.some(symbol => tokenOrder.includes(symbol as TokenSymbol))), [pools]);
  const holderData = details[holderToken]?.holders ?? [];
  const visibleTransfers = transfers.filter(transfer => ledgerToken === 'ALL' || transfer.analyticsSymbol === ledgerToken).slice(0, 20);
  const availableCount = tokenRecords.filter(token => details[token.symbol]).length;

  const jumpTo = (id: string) => {
    setSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const analyticsTokens = tokenRecords;
  const detailFor = (symbol: TokenSymbol) => details[symbol];

  return (
    <main className="token-analytics-page">
      <header className="analytics-page-header">
        <div>
          <p className="analytics-eyebrow">Circleswap · Cyprus-1</p>
          <h1>Token analytics</h1>
          <p className="analytics-lede">Compare Q0, BDELTA, and QRB market signals, pool pricing, holder distribution, and recent transfers.</p>
        </div>
        <div className="analytics-header-actions">
          <span className="analytics-chain-status"><i /> Block {latestBlock.toLocaleString()}</span>
          <button className="analytics-refresh" type="button" onClick={() => setRefreshKey(value => value + 1)} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'analytics-spin' : ''} /> Refresh data
          </button>
        </div>
      </header>

      <nav className="analytics-section-nav" aria-label="Analytics sections">
        {[
          ['analytics-overview', 'Overview'],
          ['analytics-relative', 'Relative value'],
          ['analytics-liquidity', 'Liquidity'],
          ['analytics-holders', 'Holders'],
          ['analytics-ledger', 'Ledger']
        ].map(([id, label]) => <button key={id} type="button" className={section === id ? 'active' : ''} onClick={() => jumpTo(id)}>{label}</button>)}
      </nav>

      {loading && <div className="analytics-load-note"><span className="loader" /> Reading token data from the explorer…</div>}

      <section id="analytics-overview" className="analytics-section">
        <div className="analytics-section-heading">
          <div><span className="analytics-kicker">At a glance</span><h2>Token fundamentals</h2></div>
          <span className="analytics-data-count">{availableCount} of 3 token feeds available</span>
        </div>
        <div className="token-fundamentals-grid">
          {analyticsTokens.map(token => {
            const detail = detailFor(token.symbol);
            const price = detail?.marketStats?.priceUsd;
            const supplyRaw = detail?.token.total_supply;
            const decimals = detail?.token.decimals ?? TOKEN_REGISTRY[token.symbol]?.decimals ?? 18;
            return (
              <article className="token-fundamental-card" key={token.symbol} style={{ '--token-accent': token.color } as CSSProperties}>
                <div className="token-fundamental-top">
                  <span className="analytics-token-mark">{token.symbol.slice(0, 1)}</span>
                  <div><h3>{detail?.token.symbol ?? token.symbol}</h3><p>{detail?.token.name ?? token.name}</p></div>
                  <a href={token.address ? `https://explorer.qu.ai/token/${token.address}` : undefined} target="_blank" rel="noreferrer" aria-label={`View ${token.symbol} on explorer`} className="analytics-icon-link"><ExternalLink size={15} /></a>
                </div>
                <div className="token-price-line"><span>{formatUsd(price)}</span><small>USD price</small></div>
                <div className="token-fundamental-metrics">
                  <div><span>Market cap</span><strong>{formatUsd(detail?.marketStats?.marketCapUsd)}</strong><small>{changeLabel(detail?.marketStats?.marketCapGrowth24h)} · 24h</small></div>
                  <div><span>Holders</span><strong>{detail ? compactNumber(detail.token.holder_count) : '—'}</strong><small>{changeLabel(detail?.marketStats?.holderGrowth24h)} · 24h</small></div>
                  <div><span>24h transfers</span><strong>{detail ? compactNumber(detail.transfers24h) : '—'}</strong><small>{changeLabel(detail?.marketStats?.transferGrowth24h)} · change</small></div>
                  <div><span>Total supply</span><strong>{supplyRaw ? displayAmount(supplyRaw, decimals, 3) : '—'} {detail?.token.symbol ?? token.symbol}</strong></div>
                </div>
                {!detail && <p className="analytics-inline-status">{failures[token.symbol] ?? (token.symbol === 'QRB' ? 'Deployment address not recorded.' : 'Waiting for token data.')}</p>}
              </article>
            );
          })}
        </div>
      </section>

      <section id="analytics-relative" className="analytics-section">
        <div className="analytics-section-heading">
          <div><span className="analytics-kicker">Cross-token signals</span><h2>Relative value</h2></div>
          <span className="analytics-data-count">USD ratios and live AMM spot ratios</span>
        </div>
        <div className="analytics-card analytics-relative-card">
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead><tr><th>Pair</th><th>Explorer ratio</th><th>AMM spot ratio</th><th>AMM path</th></tr></thead>
              <tbody>
                {trackedPairs.map(pair => (
                  <tr key={`${pair.from}-${pair.to}`}>
                    <td><strong>{pair.from} / {pair.to}</strong></td>
                    <td>{pair.usdRate ? `1 ${pair.from} = ${pair.usdRate.toLocaleString(undefined, { maximumFractionDigits: 8 })} ${pair.to}` : 'Price feed unavailable'}</td>
                    <td>{pair.amm ? `1 ${pair.from} = ${pair.amm.rate.toLocaleString(undefined, { maximumFractionDigits: 8 })} ${pair.to}` : 'No connected live pool'}</td>
                    <td>{pair.amm ? pair.amm.path.join(' → ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="analytics-footnote">AMM ratios are reserve based spot estimates and can differ across DEXes. Explorer USD ratios use each token’s current indexed price. Historical price correlation is not available from this data feed.</p>
        </div>
      </section>

      <section id="analytics-liquidity" className="analytics-section">
        <div className="analytics-section-heading">
          <div><span className="analytics-kicker">Market depth</span><h2>Liquidity connecting these tokens</h2></div>
          <span className="analytics-data-count">{relevantPools.length} pools found</span>
        </div>
        <div className="analytics-card">
          {relevantPools.length ? (
            <div className="analytics-pool-list">
              {relevantPools.map(pool => {
                const reserve = poolReserves[pool.pair.toLowerCase()];
                const token0 = TOKEN_REGISTRY[pool.tokens[0]];
                const token1 = TOKEN_REGISTRY[pool.tokens[1]];
                const reserve0 = reserve ? reserveForToken(reserve, pool.tokens[0]) : '0';
                const reserve1 = reserve ? reserveForToken(reserve, pool.tokens[1]) : '0';
                return (
                  <div className="analytics-pool-row" key={`${pool.dex}-${pool.pair}`}>
                    <div className="analytics-pool-name"><strong>{pool.tokens.map(tokenLabel).join(' / ')}</strong><span>{dexName(pool.dex)} · {shortAddress(pool.pair)}</span></div>
                    <div className="analytics-pool-reserve"><span>{pool.tokens[0]}</span><strong>{displayAmount(reserve0, token0?.decimals ?? 18, 3)}</strong></div>
                    <div className="analytics-pool-reserve"><span>{pool.tokens[1]}</span><strong>{displayAmount(reserve1, token1?.decimals ?? 18, 3)}</strong></div>
                    <a href={`https://explorer.qu.ai/address/${pool.pair}`} target="_blank" rel="noreferrer" className="analytics-icon-link" aria-label="View pool on explorer"><ExternalLink size={15} /></a>
                  </div>
                );
              })}
            </div>
          ) : <div className="analytics-empty">No active pools containing Q0, BDELTA, or QRB were returned.</div>}
        </div>
      </section>

      <div className="analytics-lower-grid">
        <section id="analytics-holders" className="analytics-section">
          <div className="analytics-section-heading">
            <div><span className="analytics-kicker">Distribution</span><h2>Largest holders</h2></div>
            <div className="analytics-segmented" role="group" aria-label="Select token holder list">
              {tokenOrder.map(symbol => <button key={symbol} type="button" className={holderToken === symbol ? 'active' : ''} onClick={() => setHolderToken(symbol)}>{symbol}</button>)}
            </div>
          </div>
          <div className="analytics-card">
            {holderData.length ? <div className="analytics-holder-list">{holderData.slice(0, 8).map((holder, index) => {
              const decimals = detailFor(holderToken)?.token.decimals ?? 18;
              return <div className="analytics-holder-row" key={holder.address}>
                <span className="analytics-holder-rank">{String(index + 1).padStart(2, '0')}</span>
                <a href={`https://explorer.qu.ai/address/${holder.address}`} target="_blank" rel="noreferrer">{shortAddress(holder.address)}</a>
                <div className="analytics-holder-share"><strong>{displayAmount(holder.balance, decimals, 3)} {holderToken}</strong><span>{holder.percentage.toFixed(2)}% of supply</span><i><b style={{ width: `${Math.min(holder.percentage, 100)}%` }} /></i></div>
              </div>;
            })}</div> : <div className="analytics-empty">{loading ? 'Loading holder distribution…' : failures[holderToken] ?? `No holder data is available for ${holderToken}.`}</div>}
          </div>
        </section>

        <section id="analytics-ledger" className="analytics-section">
          <div className="analytics-section-heading">
            <div><span className="analytics-kicker">Recent activity</span><h2>Transfer ledger</h2></div>
            <select className="analytics-filter" aria-label="Filter transfers by token" value={ledgerToken} onChange={event => setLedgerToken(event.target.value as 'ALL' | TokenSymbol)}>
              <option value="ALL">All tokens</option>{tokenOrder.map(symbol => <option key={symbol} value={symbol}>{symbol}</option>)}
            </select>
          </div>
          <div className="analytics-card analytics-ledger-card">
            <div className="analytics-table-wrap">
              <table className="analytics-table analytics-ledger-table">
                <thead><tr><th>Asset</th><th>Transfer</th><th>From → to</th><th>Block / time</th></tr></thead>
                <tbody>
                  {visibleTransfers.map((transfer, index) => <LedgerRow key={`${transfer.analyticsSymbol}-${transfer.id || transfer.tx_hash}-${index}`} transfer={transfer} symbol={transfer.analyticsSymbol} decimals={detailFor(transfer.analyticsSymbol)?.token.decimals ?? 18} />)}
                </tbody>
              </table>
            </div>
            {!visibleTransfers.length && <div className="analytics-empty">{loading ? 'Loading token transfers…' : 'No recent transfer events for this selection.'}</div>}
            <p className="analytics-footnote">Showing up to 20 recent token transfer events across available feeds. Select a hash to inspect it in the explorer.</p>
          </div>
        </section>
      </div>

      <footer className="analytics-data-footer"><Database size={14} /> Explorer indexed token data · Cyprus-1 block {latestBlock.toLocaleString()} · {failures.QRB ? `QRB: ${failures.QRB}` : 'QRB feed connected'}</footer>
    </main>
  );
}

function dexName(id: DexId): string {
  return id === 'QUAINANCE' ? 'Quainance' : id === 'QUAISWAP' ? 'Quaiswap' : 'Circleswap';
}

function LedgerRow({ transfer, symbol, decimals }: { transfer: TokenTransferV2; symbol: TokenSymbol; decimals: number }) {
  return (
    <tr>
      <td><span className={`analytics-asset-tag analytics-asset-${symbol.toLowerCase()}`}>{symbol}</span></td>
      <td><a href={`https://explorer.qu.ai/tx/${transfer.tx_hash}`} target="_blank" rel="noreferrer" className="analytics-hash-link">{shortAddress(transfer.tx_hash)}</a><small>{displayAmount(transfer.value, decimals, 5)} {symbol}</small></td>
      <td><span className="analytics-address-line">{shortAddress(transfer.from_addr)} <ArrowDownUp size={12} /> {shortAddress(transfer.to_addr)}</span></td>
      <td><strong>#{Number(transfer.block_height).toLocaleString()}</strong><small>{timeLabel(transfer.timestamp)}</small></td>
    </tr>
  );
}

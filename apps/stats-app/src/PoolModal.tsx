import { useEffect, useMemo, useState } from 'react';
import { X, Droplets, AlertTriangle, ExternalLink } from 'lucide-react';
import {
  DEXES,
  TOKEN_REGISTRY,
  isDexLive,
  requireDex,
  type DexId,
  type LPReserves,
  type LpPosition,
  type PoolInfo,
  getLPReserves,
  getPairAddress,
  getAllowance,
  getLpPosition,
  getLpTotalSupply,
  encodeApprove,
  encodeAddLiquidity,
  encodeRemoveLiquidity,
  estimateLpMint,
  lpUnderlying,
  removeLiquidityMins,
  quoteLiquidityB,
  applySlippage,
  prepareContractCall,
  waitForReceipt,
  parseUnits,
  formatUnits
} from 'quai-service';
import { sendWalletTransaction, getQuaiProvider } from './providerUtils';

const POOL_TOKENS = Object.values(TOKEN_REGISTRY).filter(t => !t.isNative && t.deployed !== false);

// Circleswap first: it is our own AMM, so these are the pools we can create and own the whole path of.
const PRESETS: { label: string; dex: DexId; a: string; b: string }[] = [
  { label: 'BDELTA / Q0 · Circleswap', dex: 'CIRCLESWAP', a: 'BDELTA', b: 'Q0' },
  { label: 'BDELTA / WQUAI · Circleswap', dex: 'CIRCLESWAP', a: 'BDELTA', b: 'WQUAI' },
  { label: 'BDELTA / Q0 · Quaiswap', dex: 'QUAISWAP', a: 'BDELTA', b: 'Q0' },
  { label: 'BDELTA / Q0 · Quainance', dex: 'QUAINANCE', a: 'BDELTA', b: 'Q0' },
  { label: 'BDELTA / WQUAI · Quaiswap', dex: 'QUAISWAP', a: 'BDELTA', b: 'WQUAI' }
];

type Mode = 'ADD' | 'REMOVE';
type Step = 'IDLE' | 'PREPARING' | 'APPROVE_A' | 'APPROVE_B' | 'ADD' | 'APPROVE_LP' | 'REMOVE';

interface Props {
  walletAddress: string | null;
  rawBalances: Record<string, string>;
  /** Every pool the app knows (registry plus discovered), for the "your positions" list. */
  pools: PoolInfo[];
  /** LP token balances of the wallet, keyed by lower-cased pair address. */
  lpBalances: Record<string, string>;
  onConnect: () => void;
  onClose: () => void;
  /** Called after a successful deposit or withdrawal so the app can re-read pools and balances. */
  onDone: () => void;
}

const box: React.CSSProperties = {
  background: 'rgba(0,0,0,0.35)',
  border: '1px solid var(--panel-border)',
  borderRadius: '12px',
  padding: '0.75rem 1rem'
};
const field: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: '#fff',
  fontSize: '1.1rem'
};
const select: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid var(--panel-border)',
  borderRadius: '8px',
  color: '#fff',
  padding: '0.35rem 0.5rem',
  fontWeight: 700
};
const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: '0.5rem' };
const muted: React.CSSProperties = { color: 'var(--text-muted)' };
const chip: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--panel-border)',
  color: 'var(--accent-plasma)',
  borderRadius: '4px',
  fontSize: '0.65rem',
  fontWeight: 700,
  cursor: 'pointer',
  padding: '0 0.35rem'
};

const lpName = (dex: DexId) => (dex === 'CIRCLESWAP' ? 'CSLP' : 'LP');

export default function PoolModal({ walletAddress, rawBalances, pools, lpBalances, onConnect, onClose, onDone }: Props) {
  const [mode, setMode] = useState<Mode>('ADD');
  const [dex, setDex] = useState<DexId>(isDexLive('CIRCLESWAP') ? 'CIRCLESWAP' : 'QUAISWAP');
  const [symA, setSymA] = useState('BDELTA');
  const [symB, setSymB] = useState('Q0');
  const [amtA, setAmtA] = useState('');
  const [amtB, setAmtB] = useState('');
  const [slippage, setSlippage] = useState(1);

  const [pair, setPair] = useState<string | null>(null);
  const [reserves, setReserves] = useState<LPReserves | null>(null);
  const [supply, setSupply] = useState<bigint | null>(null);
  const [pairLoading, setPairLoading] = useState(false);
  // Bumped after a transaction so the pool, supply and position are read again.
  const [refresh, setRefresh] = useState(0);

  // Remove mode: the wallet's position in the selected pool and how much of it to withdraw.
  const [position, setPosition] = useState<LpPosition | null>(null);
  const [pct, setPct] = useState(50);

  const [step, setStep] = useState<Step>('IDLE');
  const [error, setError] = useState<string | null>(null);
  const [feeNote, setFeeNote] = useState<string | null>(null);
  const [doneTx, setDoneTx] = useState<string | null>(null);
  const [doneKind, setDoneKind] = useState<Mode | null>(null);
  const [createdPair, setCreatedPair] = useState<string | null>(null);

  const tokA = TOKEN_REGISTRY[symA];
  const tokB = TOKEN_REGISTRY[symB];
  const sameToken = symA === symB;
  const exists = pair !== null;
  const dexLive = isDexLive(dex);
  const dexLabel = DEXES[dex].label;
  const lp = lpName(dex);

  // Look the pair up on the chosen DEX whenever the selection changes (and after each transaction).
  useEffect(() => {
    let live = true;
    setPair(null);
    setReserves(null);
    setSupply(null);
    setPosition(null);
    if (sameToken || !dexLive) return;
    setPairLoading(true);
    (async () => {
      try {
        const addr = await getPairAddress(dex, symA, symB);
        if (!live) return;
        setPair(addr);
        if (addr) {
          const [r, s, pos] = await Promise.all([
            getLPReserves(addr),
            getLpTotalSupply(addr),
            walletAddress ? getLpPosition(addr, walletAddress) : Promise.resolve(null)
          ]);
          if (!live) return;
          setReserves(r);
          setSupply(s);
          setPosition(pos);
        }
      } catch (e: any) {
        if (live) setError(`Could not read the ${dexLabel} factory: ${e.message}`);
      } finally {
        if (live) setPairLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [dex, symA, symB, sameToken, dexLive, dexLabel, walletAddress, refresh]);

  // Reserve of A / B in the pool's own token order.
  const resAB = useMemo(() => {
    if (!reserves) return null;
    const aIsToken0 = reserves.token0.toLowerCase() === tokA.address.toLowerCase();
    return {
      a: BigInt(aIsToken0 ? reserves.reserve0 : reserves.reserve1),
      b: BigInt(aIsToken0 ? reserves.reserve1 : reserves.reserve0)
    };
  }, [reserves, tokA]);
  const poolHasLiquidity = !!resAB && resAB.a > 0n && resAB.b > 0n;

  const parse = (v: string): bigint | null => {
    if (!v) return null;
    try {
      return parseUnits(v);
    } catch {
      return null;
    }
  };
  const a = parse(amtA);
  const b = parse(amtB);

  // With existing liquidity the two sides are tied to the pool ratio, as in Uniswap's add-liquidity form.
  const onChangeA = (v: string) => {
    setAmtA(v);
    if (poolHasLiquidity && resAB) {
      const x = parse(v);
      setAmtB(x && x > 0n ? formatUnits(quoteLiquidityB(x, resAB.a, resAB.b), 18, 18) : '');
    }
  };
  const onChangeB = (v: string) => {
    setAmtB(v);
    if (poolHasLiquidity && resAB) {
      const y = parse(v);
      setAmtA(y && y > 0n ? formatUnits(quoteLiquidityB(y, resAB.b, resAB.a), 18, 18) : '');
    }
  };

  const balOf = (sym: string) => (rawBalances[sym] === undefined ? undefined : BigInt(rawBalances[sym]));
  const balA = balOf(symA);
  const balB = balOf(symB);
  const short = (bal: bigint | undefined) => (bal === undefined ? '—' : formatUnits(bal, 18, 6));

  const insufficient =
    (a !== null && balA !== undefined && a > balA ? symA : null) ||
    (b !== null && balB !== undefined && b > balB ? symB : null);

  const price = a && b && a > 0n ? Number(b) / Number(a) : null;
  const shareOfPool =
    poolHasLiquidity && resAB && a && a > 0n ? (Number(a) / (Number(resAB.a) + Number(a))) * 100 : null;

  // What the deposit will mint, computed the way the pool does (checked against the contract in the test suite).
  const lpEstimate =
    a && b && a > 0n && b > 0n && !sameToken && dexLive && !pairLoading && (!exists || (resAB && supply !== null))
      ? estimateLpMint(a, b, resAB?.a ?? 0n, resAB?.b ?? 0n, supply ?? 0n)
      : null;
  const tooSmall = lpEstimate === 0n;

  // ---- remove mode ----------------------------------------------------------------------------------------
  const aIsToken0 = !!position && position.token0.toLowerCase() === tokA.address.toLowerCase();
  const removeLiq = position ? (pct >= 100 ? position.balance : (position.balance * BigInt(pct)) / 100n) : 0n;
  const removeOut = position ? lpUnderlying(removeLiq, position.totalSupply, position.reserve0, position.reserve1) : null;
  const removeA = removeOut ? (aIsToken0 ? removeOut[0] : removeOut[1]) : null;
  const removeB = removeOut ? (aIsToken0 ? removeOut[1] : removeOut[0]) : null;
  const hasPosition = !!position && position.balance > 0n;

  const positions = pools.filter(p => (lpBalances[p.pair.toLowerCase()] ?? '0') !== '0' && isDexLive(p.dex));

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setDex(p.dex);
    setSymA(p.a);
    setSymB(p.b);
    setAmtA('');
    setAmtB('');
    setError(null);
  };
  const applyPosition = (p: PoolInfo) => {
    setDex(p.dex);
    setSymA(p.tokens[0]);
    setSymB(p.tokens[1]);
    setError(null);
    setDoneTx(null);
  };
  const switchMode = (m: Mode) => {
    setMode(m);
    setError(null);
    setFeeNote(null);
    setDoneTx(null);
  };

  const busy = step !== 'IDLE';
  const ready =
    !!walletAddress && !sameToken && dexLive && !pairLoading && a !== null && a > 0n && b !== null && b > 0n && !insufficient && !tooSmall;
  const removeReady = !!walletAddress && !sameToken && dexLive && !pairLoading && exists && hasPosition && removeLiq > 0n;

  const submitAdd = async () => {
    if (!walletAddress) {
      onConnect();
      return;
    }
    if (!a || !b || a <= 0n || b <= 0n) return;
    const provider = getQuaiProvider();
    if (!provider) {
      setError('No Pelagus / Quai wallet found.');
      return;
    }
    setError(null);
    setFeeNote(null);
    setDoneTx(null);

    try {
      const router = requireDex(dex).router;
      setStep('PREPARING');

      // Re-read the pair at signing time: someone may have created it since the form was opened.
      const livePair = await getPairAddress(dex, symA, symB);
      let liveRes: { a: bigint; b: bigint } | null = null;
      if (livePair) {
        const r = await getLPReserves(livePair);
        const aIs0 = r.token0.toLowerCase() === tokA.address.toLowerCase();
        liveRes = { a: BigInt(aIs0 ? r.reserve0 : r.reserve1), b: BigInt(aIs0 ? r.reserve1 : r.reserve0) };
      }
      const liveHasLiquidity = !!liveRes && liveRes.a > 0n && liveRes.b > 0n;

      // Existing pool: hold the router to the ratio the user saw, within tolerance. New pool: the deposit
      // itself sets the price, so require it exactly.
      const minA = liveHasLiquidity ? applySlippage(a, slippage) : a;
      const minB = liveHasLiquidity ? applySlippage(b, slippage) : b;

      for (const [tok, amt, stepName] of [
        [tokA, a, 'APPROVE_A'],
        [tokB, b, 'APPROVE_B']
      ] as const) {
        const allowance = await getAllowance(tok.address, walletAddress, router);
        if (allowance >= amt) continue;
        setStep(stepName);
        const tx = await sendWalletTransaction(provider, {
          from: walletAddress,
          to: tok.address,
          data: encodeApprove(router, amt),
          gas: '0x30d40'
        });
        await waitForReceipt(tx);
      }

      setStep('PREPARING');
      const data = encodeAddLiquidity({
        tokenA: tokA.address,
        tokenB: tokB.address,
        amountADesired: a,
        amountBDesired: b,
        amountAMin: minA,
        amountBMin: minB,
        to: walletAddress,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 1200)
      });
      // Creating the pair deploys a contract, which costs far more than the simulator's estimate.
      const prepared = await prepareContractCall(walletAddress, router, data, livePair ? 1.5 : 3);
      setFeeNote(
        `Gas limit ${prepared.gasLimit.toString()}: at the current gas price this can cost up to ${formatUnits(prepared.maxFee, 18, 2)} QUAI (unused gas is refunded).`
      );

      setStep('ADD');
      const txHash = await sendWalletTransaction(provider, prepared.tx);
      setDoneTx(txHash);
      setDoneKind('ADD');
      await waitForReceipt(txHash);

      setCreatedPair(await getPairAddress(dex, symA, symB));
      setAmtA('');
      setAmtB('');
      setRefresh(n => n + 1);
      onDone();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setStep('IDLE');
    }
  };

  const submitRemove = async () => {
    if (!walletAddress) {
      onConnect();
      return;
    }
    const provider = getQuaiProvider();
    if (!provider) {
      setError('No Pelagus / Quai wallet found.');
      return;
    }
    setError(null);
    setFeeNote(null);
    setDoneTx(null);

    try {
      const router = requireDex(dex).router;
      setStep('PREPARING');

      // Everything the withdrawal is priced from is read again now, so the minimums are not built from the
      // page-load reserves and "100%" really is the whole balance at signing time.
      const livePair = await getPairAddress(dex, symA, symB);
      if (!livePair) throw new Error(`No ${symA}/${symB} pool exists on ${dexLabel}.`);
      const fresh = await getLpPosition(livePair, walletAddress);
      const liq = pct >= 100 ? fresh.balance : (fresh.balance * BigInt(pct)) / 100n;
      if (liq <= 0n) throw new Error(`You hold no ${lp} in this pool.`);

      const [u0, u1] = lpUnderlying(liq, fresh.totalSupply, fresh.reserve0, fresh.reserve1);
      const freshAIs0 = fresh.token0.toLowerCase() === tokA.address.toLowerCase();
      const [minA, minB] = removeLiquidityMins(freshAIs0 ? u0 : u1, freshAIs0 ? u1 : u0, slippage);

      // The router pulls the LP tokens from the wallet, so it needs an allowance on the LP token itself.
      const allowance = await getAllowance(livePair, walletAddress, router);
      if (allowance < liq) {
        setStep('APPROVE_LP');
        const tx = await sendWalletTransaction(provider, {
          from: walletAddress,
          to: livePair,
          data: encodeApprove(router, liq),
          gas: '0x30d40'
        });
        await waitForReceipt(tx);
      }

      setStep('PREPARING');
      const data = encodeRemoveLiquidity({
        tokenA: tokA.address,
        tokenB: tokB.address,
        liquidity: liq,
        amountAMin: minA,
        amountBMin: minB,
        to: walletAddress,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 1200)
      });
      const prepared = await prepareContractCall(walletAddress, router, data, 1.5);
      setFeeNote(
        `Gas limit ${prepared.gasLimit.toString()}: at the current gas price this can cost up to ${formatUnits(prepared.maxFee, 18, 2)} QUAI (unused gas is refunded).`
      );

      setStep('REMOVE');
      const txHash = await sendWalletTransaction(provider, prepared.tx);
      setDoneTx(txHash);
      setDoneKind('REMOVE');
      await waitForReceipt(txHash);

      setRefresh(n => n + 1);
      onDone();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setStep('IDLE');
    }
  };

  const stepText: Record<Step, string> = {
    IDLE: '',
    PREPARING: 'Simulating on Cyprus-1…',
    APPROVE_A: `Approve ${symA} in your wallet…`,
    APPROVE_B: `Approve ${symB} in your wallet…`,
    ADD: exists ? 'Confirm the deposit in your wallet…' : 'Confirm pool creation + first deposit in your wallet…',
    APPROVE_LP: `Approve the router to take your ${lp} in your wallet…`,
    REMOVE: 'Confirm the withdrawal in your wallet…'
  };

  const liveDex = dexLive ? requireDex(dex) : null;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem', overflowY: 'auto' }}
      role="dialog"
      aria-modal="true"
      aria-label="Create pool / add or remove liquidity"
    >
      <div className="glass-card" style={{ width: '100%', maxWidth: '480px', border: '1px solid rgba(255, 51, 68, 0.4)', maxHeight: '95vh', overflowY: 'auto' }}>
        <div style={{ ...row, alignItems: 'center', marginBottom: '0.75rem' }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', fontWeight: 800, color: '#fff', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <Droplets size={20} style={{ color: 'var(--accent-plasma)' }} /> Liquidity
          </h3>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        <div role="tablist" style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem' }}>
          {(['ADD', 'REMOVE'] as const).map(m => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              type="button"
              onClick={() => switchMode(m)}
              disabled={busy}
              style={{ ...select, flex: 1, cursor: 'pointer', borderColor: mode === m ? 'var(--accent-plasma)' : 'var(--panel-border)', background: mode === m ? 'rgba(255, 51, 68, 0.12)' : select.background }}
            >
              {m === 'ADD' ? 'Add / Create Pool' : 'Remove'}
            </button>
          ))}
        </div>

        {mode === 'ADD' ? (
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            {PRESETS.map(p => {
              const live = isDexLive(p.dex);
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p)}
                  disabled={busy || !live}
                  title={live ? undefined : `${DEXES[p.dex].label} is not deployed yet`}
                  style={{ ...select, fontSize: '0.72rem', cursor: live ? 'pointer' : 'not-allowed', opacity: live ? 1 : 0.45, borderColor: dex === p.dex && symA === p.a && symB === p.b ? 'var(--accent-plasma)' : 'var(--panel-border)' }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ ...box, marginBottom: '0.75rem' }}>
            <div style={{ fontSize: '0.75rem', ...muted, marginBottom: '0.4rem' }}>Your positions</div>
            {!walletAddress ? (
              <span style={{ fontSize: '0.8rem', ...muted }}>Connect your wallet to see your pool tokens.</span>
            ) : positions.length === 0 ? (
              <span style={{ fontSize: '0.8rem', ...muted }}>You hold no LP tokens in any known pool.</span>
            ) : (
              <div style={{ display: 'grid', gap: '0.3rem' }}>
                {positions.map(p => {
                  const selected = p.dex === dex && ((p.tokens[0] === symA && p.tokens[1] === symB) || (p.tokens[0] === symB && p.tokens[1] === symA));
                  return (
                    <button
                      key={p.pair}
                      type="button"
                      disabled={busy}
                      onClick={() => applyPosition(p)}
                      style={{ ...select, ...row, fontSize: '0.78rem', cursor: 'pointer', borderColor: selected ? 'var(--accent-plasma)' : 'var(--panel-border)' }}
                    >
                      <span>{p.tokens[0]} / {p.tokens[1]} · {DEXES[p.dex].label}</span>
                      <span style={{ fontWeight: 400 }}>{formatUnits(BigInt(lpBalances[p.pair.toLowerCase()]), 18, 6)} {lpName(p.dex)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div style={{ ...box, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.8rem', ...muted }}>DEX</span>
          <select value={dex} onChange={e => setDex(e.target.value as DexId)} disabled={busy} style={select}>
            {Object.values(DEXES).map(d => (
              <option key={d.id} value={d.id} disabled={!isDexLive(d.id)}>
                {d.label}{isDexLive(d.id) ? '' : ' (not deployed yet)'}
              </option>
            ))}
          </select>
        </div>

        {dex === 'CIRCLESWAP' && dexLive && (
          <div style={{ fontSize: '0.72rem', ...muted, marginBottom: '0.75rem', lineHeight: 1.45 }}>
            Circleswap is our own AMM: a 0.3% fee on every swap goes to the pool, and your share is a standard ERC-20 token ({lp}) you can hold or stake.
            The first deposit into a pool permanently locks a tiny amount of it. These contracts are new and have not been independently audited.
          </div>
        )}

        {([['A', symA, setSymA, amtA, onChangeA, balA], ['B', symB, setSymB, amtB, onChangeB, balB]] as const).map(
          ([k, sym, setSym, amt, onAmt, bal]) => (
            <div key={k} style={{ ...box, marginBottom: '0.75rem' }}>
              <div style={{ ...row, fontSize: '0.75rem', ...muted, marginBottom: '0.35rem' }}>
                <span>Token {k}</span>
                {mode === 'ADD' && (
                  <span>
                    Balance: {walletAddress ? short(bal) : '—'}
                    {walletAddress && bal !== undefined && bal > 0n && (
                      <button type="button" disabled={busy} onClick={() => onAmt(formatUnits(bal, 18, 18))} style={{ ...chip, marginLeft: '0.5rem' }}>
                        MAX
                      </button>
                    )}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                {mode === 'ADD' ? (
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0.0"
                    value={amt}
                    disabled={busy}
                    onChange={e => onAmt(e.target.value)}
                    style={field}
                  />
                ) : (
                  <span style={{ ...field, opacity: 0.85 }}>
                    {(k === 'A' ? removeA : removeB) !== null ? `≈ ${formatUnits((k === 'A' ? removeA : removeB)!, 18, 6)}` : '—'}
                  </span>
                )}
                <select value={sym} onChange={e => { setSym(e.target.value); setAmtA(''); setAmtB(''); }} disabled={busy} style={select}>
                  {POOL_TOKENS.map(t => (
                    <option key={t.symbol} value={t.symbol}>{t.symbol}</option>
                  ))}
                </select>
              </div>
            </div>
          )
        )}

        {mode === 'ADD' && (symA === 'WQUAI' || symB === 'WQUAI') && (
          <div style={{ fontSize: '0.72rem', ...muted, marginBottom: '0.75rem' }}>
            WQUAI is wrapped QUAI. It is a separate token, so you need a WQUAI balance (wrap some native QUAI first); your native QUAI is not used.
          </div>
        )}

        {/* Pool status */}
        <div style={{ ...box, marginBottom: '0.75rem', fontSize: '0.8rem', display: 'grid', gap: '0.35rem' }}>
          {sameToken ? (
            <span style={{ color: 'var(--error)' }}>Pick two different tokens.</span>
          ) : !dexLive ? (
            <span style={{ color: 'var(--accent-amber, #f59e0b)' }}>{dexLabel} is not deployed yet, so it has no pools. Choose another DEX.</span>
          ) : pairLoading ? (
            <span style={muted}>Checking {dexLabel} factory…</span>
          ) : exists ? (
            <>
              <div style={row}>
                <span style={muted}>Pool</span>
                <a href={`https://quaiscan.io/address/${pair}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-neon)', fontFamily: 'monospace' }}>
                  {pair!.slice(0, 8)}…{pair!.slice(-6)}
                </a>
              </div>
              {poolHasLiquidity && resAB ? (
                <div style={row}>
                  <span style={muted}>Reserves</span>
                  <span>{formatUnits(resAB.a, 18, 2)} {symA} / {formatUnits(resAB.b, 18, 2)} {symB}</span>
                </div>
              ) : (
                <span style={{ color: 'var(--accent-amber, #f59e0b)' }}>
                  This pair exists but is empty, so your deposit sets its price.
                </span>
              )}
              {mode === 'ADD' && shareOfPool !== null && (
                <div style={row}>
                  <span style={muted}>Your share of pool</span>
                  <span>~{shareOfPool < 0.01 ? '<0.01' : shareOfPool.toFixed(2)}%</span>
                </div>
              )}
              {walletAddress && position && (
                <div style={row}>
                  <span style={muted}>Your position</span>
                  <span>
                    {formatUnits(position.balance, 18, 6)} {lp}
                    {position.balance > 0n && ` (${position.sharePct < 0.01 ? '<0.01' : position.sharePct.toFixed(2)}%)`}
                  </span>
                </div>
              )}
            </>
          ) : mode === 'ADD' ? (
            <span style={{ color: 'var(--accent-amber, #f59e0b)' }}>
              No {symA}/{symB} pair exists on {dexLabel}. Your first deposit will create it and set its price.
            </span>
          ) : (
            <span style={{ color: 'var(--accent-amber, #f59e0b)' }}>No {symA}/{symB} pool exists on {dexLabel}.</span>
          )}

          {mode === 'ADD' && price !== null && !sameToken && (!exists || !poolHasLiquidity) && (
            <div style={row}>
              <span style={muted}>Initial price</span>
              <span>1 {symA} = {price.toPrecision(6)} {symB}</span>
            </div>
          )}
          {mode === 'ADD' && lpEstimate !== null && lpEstimate > 0n && (
            <div style={row}>
              <span style={muted}>You receive</span>
              <span>≈ {formatUnits(lpEstimate, 18, 6)} {lp}</span>
            </div>
          )}
          {mode === 'ADD' && poolHasLiquidity && (
            <div style={{ ...row, alignItems: 'center' }}>
              <span style={muted}>Slippage tolerance</span>
              <SlippageInput value={slippage} onChange={setSlippage} />
            </div>
          )}

          {mode === 'REMOVE' && exists && hasPosition && (
            <>
              <div style={{ ...row, alignItems: 'center' }}>
                <span style={muted}>Amount to remove</span>
                <span style={{ fontWeight: 700 }}>{pct}%</span>
              </div>
              <input
                type="range"
                min={1}
                max={100}
                step={1}
                value={pct}
                disabled={busy}
                onChange={e => setPct(Number(e.target.value))}
                aria-label="Percent of your position to remove"
                style={{ width: '100%' }}
              />
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                {[25, 50, 75, 100].map(v => (
                  <button key={v} type="button" disabled={busy} onClick={() => setPct(v)} style={{ ...chip, flex: 1, padding: '0.2rem 0', borderColor: pct === v ? 'var(--accent-plasma)' : 'var(--panel-border)' }}>
                    {v === 100 ? 'MAX' : `${v}%`}
                  </button>
                ))}
              </div>
              <div style={row}>
                <span style={muted}>{lp} to burn</span>
                <span>{formatUnits(removeLiq, 18, 6)}</span>
              </div>
              <div style={{ ...row, alignItems: 'center' }}>
                <span style={muted}>Slippage tolerance</span>
                <SlippageInput value={slippage} onChange={setSlippage} />
              </div>
            </>
          )}
          {mode === 'REMOVE' && exists && walletAddress && position && !hasPosition && (
            <span style={muted}>You hold no {lp} in this pool.</span>
          )}
        </div>

        {mode === 'ADD' && dexLive && !exists && !sameToken && !pairLoading && (
          <div style={{ display: 'flex', gap: '0.5rem', background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.35)', borderRadius: '12px', padding: '0.6rem 0.8rem', fontSize: '0.75rem', color: 'var(--accent-amber, #f59e0b)', marginBottom: '0.75rem' }}>
            <AlertTriangle size={16} style={{ flexShrink: 0 }} />
            <span>
              The ratio you enter becomes the pool price. If it is off-market, arbitrageurs will take the difference from
              your deposit. Creating a pair deploys a contract, so this transaction costs far more gas than a swap.
            </span>
          </div>
        )}

        {mode === 'ADD' && tooSmall && (
          <div style={{ fontSize: '0.8rem', color: 'var(--error)', marginBottom: '0.75rem' }}>
            That deposit is too small to mint any {lp}; the pool would refuse it. Enter a larger amount.
          </div>
        )}
        {mode === 'ADD' && insufficient && (
          <div style={{ fontSize: '0.8rem', color: 'var(--error)', marginBottom: '0.75rem' }}>Insufficient {insufficient} balance.</div>
        )}
        {busy && (
          <div style={{ fontSize: '0.8rem', color: 'var(--accent-neon)', marginBottom: '0.75rem' }}>{stepText[step]}</div>
        )}
        {feeNote && <div style={{ fontSize: '0.72rem', ...muted, marginBottom: '0.75rem' }}>{feeNote}</div>}
        {error && (
          <div style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)', padding: '0.6rem 0.8rem', borderRadius: '10px', fontSize: '0.8rem', color: 'var(--error)', marginBottom: '0.75rem', wordBreak: 'break-word' }}>
            {error}
          </div>
        )}
        {doneTx && !busy && !error && (
          <div style={{ background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.2)', padding: '0.6rem 0.8rem', borderRadius: '10px', fontSize: '0.8rem', color: 'var(--success)', marginBottom: '0.75rem' }}>
            <strong>{doneKind === 'REMOVE' ? 'Liquidity removed.' : 'Liquidity added.'}</strong>
            {doneKind === 'ADD' && createdPair && <div style={{ fontFamily: 'monospace', fontSize: '0.7rem', wordBreak: 'break-all' }}>Pool: {createdPair}</div>}
            <a href={`https://quaiscan.io/tx/${doneTx}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-neon)', display: 'inline-flex', gap: '0.25rem', alignItems: 'center', fontSize: '0.75rem' }}>
              View transaction <ExternalLink size={12} />
            </a>
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          {mode === 'ADD' ? (
            <button
              className="btn-primary"
              onClick={submitAdd}
              disabled={busy || (!!walletAddress && !ready)}
              style={{ flex: 1, justifyContent: 'center', background: 'linear-gradient(135deg, var(--accent-plasma) 0%, #8a2be2 100%)', color: '#fff' }}
            >
              {!walletAddress ? 'Connect Wallet' : busy ? 'Working…' : exists ? 'Add Liquidity' : 'Create Pool & Add Liquidity'}
            </button>
          ) : (
            <button
              className="btn-primary"
              onClick={submitRemove}
              disabled={busy || (!!walletAddress && !removeReady)}
              style={{ flex: 1, justifyContent: 'center', background: 'linear-gradient(135deg, var(--accent-plasma) 0%, #8a2be2 100%)', color: '#fff' }}
            >
              {!walletAddress ? 'Connect Wallet' : busy ? 'Working…' : 'Remove Liquidity'}
            </button>
          )}
          <button
            className="btn-primary"
            onClick={onClose}
            style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)', border: '1px solid var(--panel-border)', boxShadow: 'none' }}
          >
            {doneTx ? 'Done' : 'Cancel'}
          </button>
        </div>
        <div className="dimmed-text" style={{ marginTop: '0.75rem' }}>
          Nothing is sent until you approve each step in your wallet.
          {liveDex && <> Router: {liveDex.label} {liveDex.router.slice(0, 8)}…{liveDex.router.slice(-4)}</>}
        </div>
      </div>
    </div>
  );
}

function SlippageInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <span>
      <input
        type="number"
        min={0}
        max={50}
        step={0.1}
        value={value}
        onChange={e => onChange(Math.max(0, Math.min(50, parseFloat(e.target.value) || 0)))}
        style={{ background: 'transparent', border: '1px solid var(--panel-border)', borderRadius: '4px', width: '52px', color: 'inherit', textAlign: 'center' }}
      /> %
    </span>
  );
}

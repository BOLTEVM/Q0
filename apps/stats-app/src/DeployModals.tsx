import { useMemo, useState } from 'react';
import { Sparkles, Factory, Sprout, Plus, Trash2 } from 'lucide-react';
import {
  DEPLOYED,
  TOKEN_REGISTRY,
  FARM_REGISTRY,
  parseUnits,
  formatUnits,
  formatBoostPct,
  formatBoostDuration,
  QRB_BOOST_THRESHOLD_WEI,
  type PoolInfo
} from 'quai-service';
import { qrbFlow, ammFlow, farmFlow, type Flow } from 'quai-service/deploy';
import { readLocalDeployments } from 'quai-service/bootstrap';
import FlowRunner from './FlowRunner';
import type { SavedArtwork } from './artwork';
import { Modal, Field, Notice, input, muted, smallBtn, select, box, row } from './ui';

interface CommonProps {
  walletAddress: string | null;
  onConnect: () => void;
  onClose: () => void;
  /** Opens the artwork modal (Qrb flow). */
  onOpenArtwork?: () => void;
}

/** Builds the flow for the current form, turning any validation throw into a message instead of a crash. */
function useBuilt(build: () => Flow): { flow: Flow | null; error: string | null } {
  return useMemo(() => {
    try {
      return { flow: build(), error: null };
    } catch (e: any) {
      return { flow: null, error: e?.message ?? String(e) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build]);
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

// ---------------------------------------------------------------------------------------------------------- Qrb

export function DeployQrbModal({ walletAddress, onConnect, onClose, onOpenArtwork, artwork }: CommonProps & { artwork: SavedArtwork | null }) {
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState('');
  const [royalty, setRoyalty] = useState('');
  const [mint, setMint] = useState(true);
  const [mintTo, setMintTo] = useState('');
  const ownerValue = owner || walletAddress || '';

  const cfg = useMemo(
    () => ({ owner: ownerValue, royaltyReceiver: royalty || ownerValue, artworkUri: artwork?.uri ?? '', mintTo: mint ? mintTo || ownerValue : undefined }),
    [ownerValue, royalty, artwork, mint, mintTo]
  );
  const build = useMemo(() => () => qrbFlow(cfg), [cfg]);
  const { flow, error } = useBuilt(build);
  const unverified = artwork && artwork.verifiedAt === null;

  return (
    <Modal title="Deploy Qrb and the artifact NFT" icon={<Sparkles size={20} style={{ color: 'var(--accent-plasma)' }} />} onClose={onClose} locked={busy} maxWidth={620}>
      <div style={{ fontSize: '0.8rem', lineHeight: 1.5, marginBottom: '0.9rem' }}>
        Qrb is a fixed supply of exactly <strong>1.0 QRB</strong>. Holding at least {formatUnits(QRB_BOOST_THRESHOLD_WEI, 18, 4)} QRB for {formatBoostDuration()} earns <strong>+{formatBoostPct()}</strong> farm rewards.
        The NFT is a 1-of-1 collectible with a 5% royalty; it grants no boost itself. Nothing about either can be changed after deployment.
      </div>

      {!artwork ? (
        <Notice tone="danger">
          No verified artwork yet. The artwork link is permanent, so it has to be checked first.{' '}
          <button type="button" style={smallBtn} onClick={onOpenArtwork}>Set up artwork</button>
        </Notice>
      ) : (
        <Notice tone={unverified ? 'warn' : 'ok'}>
          Artwork: <span style={{ wordBreak: 'break-all' }}>{artwork.uri}</span> ({artwork.name}){unverified ? ' — saved without verification' : ' — verified'}.{' '}
          <button type="button" style={smallBtn} onClick={onOpenArtwork}>Change</button>
        </Notice>
      )}

      <Field label="Owner" hint="Administrator of both contracts and the only account that can mint. Ownership moves in two steps, but a wrong address here is not recoverable until you hold its key.">
        <input style={input} value={ownerValue} onChange={e => setOwner(e.target.value)} spellCheck={false} aria-label="Owner" />
      </Field>
      <Field label="Royalty receiver" hint="Receives the 5% royalty on NFT sales. Fixed for the life of the NFT.">
        <input style={input} value={royalty || ownerValue} onChange={e => setRoyalty(e.target.value)} spellCheck={false} aria-label="Royalty receiver" />
      </Field>
      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', marginBottom: '0.85rem', cursor: 'pointer', fontSize: '0.82rem' }}>
        <input type="checkbox" checked={mint} onChange={e => setMint(e.target.checked)} style={{ marginTop: 3 }} />
        <span>Also mint the 1.0 QRB and the NFT as part of this deployment (irreversible: each can be minted exactly once)</span>
      </label>
      {mint && (
        <Field label="Mint to">
          <input style={input} value={mintTo || ownerValue} onChange={e => setMintTo(e.target.value)} spellCheck={false} aria-label="Mint recipient" />
        </Field>
      )}

      <FlowRunner
        flowId="QRB"
        flow={artwork ? flow : null}
        configError={artwork ? error : null}
        fingerprint={json({ ...cfg, art: artwork?.sha256 })}
        artworkUri={artwork?.uri ?? null}
        walletAddress={walletAddress}
        onConnect={onConnect}
        onBusy={setBusy}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------- AMM

export function DeployAmmModal({ walletAddress, onConnect, onClose, onOpenGovernance }: CommonProps & { onOpenGovernance?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [proposer, setProposer] = useState('');
  const [delayDays, setDelayDays] = useState('2');
  const [open, setOpen] = useState(true);
  const [wquai, setWquai] = useState(TOKEN_REGISTRY.WQUAI.address);
  const proposerValue = proposer || walletAddress || '';
  const days = Number(delayDays);

  const cfg = useMemo(
    () => ({ proposer: proposerValue, delaySeconds: Math.round(days * 86_400), wquai, openExecution: open }),
    [proposerValue, days, wquai, open]
  );
  const build = useMemo(
    () => () => {
      if (!Number.isFinite(days)) throw new Error('The delay is not a number.');
      return ammFlow(cfg);
    },
    [cfg, days]
  );
  const { flow, error } = useBuilt(build);
  const proposerIsWallet = Boolean(walletAddress && proposerValue.toLowerCase() === walletAddress.toLowerCase());

  return (
    <Modal title="Deploy the Circleswap AMM" icon={<Factory size={20} style={{ color: 'var(--accent-plasma)' }} />} onClose={onClose} locked={busy} maxWidth={660}>
      <div style={{ fontSize: '0.8rem', lineHeight: 1.5, marginBottom: '0.75rem' }}>
        Five contracts: a <strong>timelock</strong>, and the <strong>factory</strong> and <strong>router</strong> (each an implementation plus an upgradable proxy that is
        initialised in the same transaction it is created, so nobody can race its set-up). The factory also creates the pool beacon: every pool is a small proxy that follows it.
      </div>

      <div style={{ ...box, marginBottom: '0.9rem', fontSize: '0.8rem', lineHeight: 1.55 }}>
        <div style={{ fontWeight: 800, marginBottom: '0.3rem' }}>What the owner can and cannot do</div>
        <ul style={{ margin: '0 0 0 1.1rem', padding: 0 }}>
          <li><strong>Owner of everything is the timelock</strong>, not a person. Every upgrade, fee change or freeze is announced on chain and waits the delay below before it can run; the proposer can cancel it.</li>
          <li>The deployer keeps <strong>no power</strong>: no role on the timelock, no ownership, no key to any contract.</li>
          <li><strong>Existing liquidity can be made untouchable</strong>: one delayed, irreversible &ldquo;freeze pool upgrades&rdquo; step removes anyone&apos;s ability to change the code of existing pools, including through a future factory upgrade.</li>
          <li>A pool&apos;s withdrawals never depend on the factory, so even a hostile factory upgrade cannot lock providers in.</li>
          <li>The router holds users&apos; token approvals, so its upgrades are the sensitive ones: they are public for the whole delay, and the router can be made permanent too.</li>
        </ul>
      </div>

      <Field label="Proposer" hint={<>The account (use a multisig) that can queue and cancel owner actions. It owns nothing else.{proposerIsWallet && <> <strong>This is your connected wallet:</strong> fine for a test deployment, not for a production one.</>}</>}>
        <input style={input} value={proposerValue} onChange={e => setProposer(e.target.value)} spellCheck={false} aria-label="Proposer" />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <Field label="Delay (days, 1 to 30)" hint="How long every owner action is public before it can run. Longer is safer for users.">
          <input style={input} value={delayDays} onChange={e => setDelayDays(e.target.value)} inputMode="decimal" aria-label="Timelock delay in days" />
        </Field>
        <Field label="WQUAI token" hint="Wrapped native QUAI, used by the router.">
          <input style={input} value={wquai} onChange={e => setWquai(e.target.value)} spellCheck={false} aria-label="WQUAI address" />
        </Field>
      </div>
      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', marginBottom: '0.85rem', cursor: 'pointer', fontSize: '0.82rem' }}>
        <input type="checkbox" checked={open} onChange={e => setOpen(e.target.checked)} style={{ marginTop: 3 }} />
        <span>Let anyone run an operation once its delay has passed (recommended). Running it is then not a privilege, so a missing proposer cannot stall a decision that was already public.</span>
      </label>
      {days < 2 && Number.isFinite(days) && days >= 1 && (
        <Notice tone="warn">A delay under two days gives liquidity providers little time to notice and react. Production deployments should use several days.</Notice>
      )}

      <FlowRunner flowId="AMM" flow={flow} configError={error} fingerprint={json(cfg)} walletAddress={walletAddress} onConnect={onConnect} onBusy={setBusy} />

      <div style={{ ...muted, fontSize: '0.75rem', marginTop: '0.9rem', lineHeight: 1.5 }}>
        After deploying: check the result in <button type="button" style={smallBtn} onClick={onOpenGovernance}>Governance &amp; integrity</button>, create the first pool from the
        liquidity modal, and when the pool code is final, queue &ldquo;freeze pool upgrades&rdquo; (and, if you want the router permanent too, &ldquo;make the router permanent&rdquo;).
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------------------------------------------- Farm

interface PoolRow {
  stakeToken: string;
  alloc: string;
  label?: string;
}

const PER_DAY = 86_400n;

export function DeployFarmModal({ walletAddress, onConnect, onClose, pools: knownPools }: CommonProps & { pools: PoolInfo[] }) {
  const [busy, setBusy] = useState(false);
  const localDeployments = readLocalDeployments();
  const existing = DEPLOYED.MASTERCHEF || localDeployments?.values.MASTERCHEF || null;
  const [addToExisting, setAddToExisting] = useState(false);
  const [owner, setOwner] = useState('');
  const initialQrb = DEPLOYED.QRB || localDeployments?.values.QRB || '';
  const [boost, setBoost] = useState(Boolean(initialQrb));
  const [qrb, setQrb] = useState(initialQrb);
  const [perDayA, setPerDayA] = useState('43.2');
  const [perDayB, setPerDayB] = useState('43200');
  const [rows, setRows] = useState<PoolRow[]>([]);
  const ownerValue = owner || walletAddress || '';

  const perSecond = (perDay: string): bigint => {
    try {
      return parseUnits(perDay || '0', 18) / PER_DAY;
    } catch {
      return -1n;
    }
  };

  const addRows = (list: PoolRow[]) => setRows(r => [...r, ...list.filter(n => !r.some(x => x.stakeToken.toLowerCase() === n.stakeToken.toLowerCase()))]);
  const circleswapPools = knownPools.filter(p => p.dex === 'CIRCLESWAP');

  const cfg = useMemo(
    () => ({
      owner: ownerValue,
      qrb: boost ? qrb : null,
      rewardAPerSecond: perSecond(perDayA),
      rewardBPerSecond: perSecond(perDayB),
      pools: rows.map(r => ({ stakeToken: r.stakeToken, allocPoint: (() => { try { return BigInt(r.alloc || '0'); } catch { return -1n; } })() })),
      existingFarm: addToExisting && existing ? existing : undefined
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ownerValue, boost, qrb, perDayA, perDayB, rows, addToExisting, existing]
  );
  const build = useMemo(
    () => () => {
      if (!addToExisting && (cfg.rewardAPerSecond < 0n || cfg.rewardBPerSecond < 0n)) throw new Error('A reward rate is not a valid number.');
      if (boost && !qrb) throw new Error('Enter the Qrb address, or turn the boost off.');
      if (addToExisting && rows.length === 0) throw new Error('Add at least one pool to add to the existing farm.');
      return farmFlow(cfg);
    },
    [cfg, addToExisting, boost, qrb, rows.length]
  );
  const { flow, error } = useBuilt(build);

  const neededA = cfg.rewardAPerSecond > 0n ? cfg.rewardAPerSecond * 86_400n * 30n : 0n;
  const neededB = cfg.rewardBPerSecond > 0n ? cfg.rewardBPerSecond * 86_400n * 30n : 0n;
  const boostMul = boost ? 2n : 1n; // the farm caps the boost at +100%

  return (
    <Modal title={addToExisting ? 'Add pools to the farm' : 'Deploy the farm'} icon={<Sprout size={20} style={{ color: 'var(--accent-plasma)' }} />} onClose={onClose} locked={busy} maxWidth={700}>
      <div style={{ fontSize: '0.8rem', lineHeight: 1.5, marginBottom: '0.9rem' }}>
        A dual-reward farm: each pool earns BoltDelta (A) and Q0 (B) per second, split by allocation. Rewards are paid only from the balance above what people have staked, so
        staked tokens can never be paid out as rewards, and a short inventory is carried forward as owed, not lost. The boost source and reward tokens are fixed at deployment.
      </div>

      {existing && (
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.85rem', cursor: 'pointer', fontSize: '0.82rem' }}>
          <input type="checkbox" checked={addToExisting} onChange={e => setAddToExisting(e.target.checked)} />
          <span>A farm is already recorded ({existing.slice(0, 8)}…). Add pools to it instead of deploying a new one.</span>
        </label>
      )}

      {!addToExisting && (
        <>
          <Field label="Owner" hint="Can add pools, change allocations and emission rates, and pause deposits (never withdrawals).">
            <input style={input} value={ownerValue} onChange={e => setOwner(e.target.value)} spellCheck={false} aria-label="Owner" />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <Field label="BDELTA per day (all pools)" hint={`= ${formatUnits(cfg.rewardAPerSecond < 0n ? 0n : cfg.rewardAPerSecond, 18, 10)} per second`}>
              <input style={input} value={perDayA} onChange={e => setPerDayA(e.target.value)} inputMode="decimal" aria-label="BDELTA per day" />
            </Field>
            <Field label="Q0 per day (all pools)" hint={`= ${formatUnits(cfg.rewardBPerSecond < 0n ? 0n : cfg.rewardBPerSecond, 18, 10)} per second`}>
              <input style={input} value={perDayB} onChange={e => setPerDayB(e.target.value)} inputMode="decimal" aria-label="Q0 per day" />
            </Field>
          </div>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', marginBottom: '0.6rem', cursor: 'pointer', fontSize: '0.82rem' }}>
            <input type="checkbox" checked={boost} onChange={e => setBoost(e.target.checked)} style={{ marginTop: 3 }} />
            <span>Pay the Qrb boost (+{formatBoostPct()} for wallets that held the threshold for {formatBoostDuration()}). Fixed at deployment.</span>
          </label>
          {boost && (
            <Field label="Qrb address" hint={DEPLOYED.QRB ? 'Filled from the recorded Qrb deployment.' : 'Deploy Qrb first, or paste an existing one.'}>
              <input style={input} value={qrb} onChange={e => setQrb(e.target.value)} spellCheck={false} aria-label="Qrb address" />
            </Field>
          )}
          {(neededA > 0n || neededB > 0n) && (
            <Notice tone="info">
              The farm starts empty and pays nothing until you send it the reward tokens. For 30 days at these rates
              {boost ? ' (with the boost, up to double)' : ''} that is about <strong>{formatUnits(neededA * boostMul, 18, 0)} BDELTA</strong> and <strong>{formatUnits(neededB * boostMul, 18, 0)} Q0</strong>.
              If it runs short, what is owed is recorded and paid after you refill.
            </Notice>
          )}
        </>
      )}

      <div style={{ ...row, alignItems: 'center', margin: '0.25rem 0 0.4rem' }}>
        <div style={{ fontWeight: 800, fontFamily: 'var(--font-display)' }}>Pools</div>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          <button type="button" style={smallBtn} onClick={() => addRows(FARM_REGISTRY.map(f => ({ stakeToken: f.stakeToken.address, alloc: String(f.allocPoint), label: f.name })))}>App defaults ({FARM_REGISTRY.length})</button>
          {circleswapPools.length > 0 && (
            <button type="button" style={smallBtn} onClick={() => addRows(circleswapPools.map(p => ({ stakeToken: p.pair, alloc: '100', label: `${p.tokens[0]}/${p.tokens[1]} (Circleswap)` })))}>Circleswap pools ({circleswapPools.length})</button>
          )}
          <button type="button" style={smallBtn} onClick={() => setRows(r => [...r, { stakeToken: '', alloc: '100' }])}><Plus size={12} /> Row</button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div style={{ ...muted, fontSize: '0.8rem', marginBottom: '0.9rem' }}>No pools yet. A farm can be deployed empty and have pools added later (owner only).</div>
      ) : (
        <div style={{ marginBottom: '0.9rem' }}>
          {rows.map((r, i) => (
            <div key={i} style={{ ...box, display: 'grid', gridTemplateColumns: '1fr 90px 32px', gap: '0.4rem', marginBottom: '0.35rem', alignItems: 'center' }}>
              <div style={{ minWidth: 0 }}>
                <input style={input} value={r.stakeToken} placeholder="Stake token or LP address (0x00…)" spellCheck={false} aria-label={`Pool ${i + 1} stake token`} onChange={e => setRows(list => list.map((x, k) => (k === i ? { ...x, stakeToken: e.target.value } : x)))} />
                {r.label && <div style={{ ...muted, fontSize: '0.68rem' }}>{r.label}</div>}
              </div>
              <input style={input} value={r.alloc} inputMode="numeric" aria-label={`Pool ${i + 1} allocation`} title="Allocation points: the pool's share is its points divided by the total" onChange={e => setRows(list => list.map((x, k) => (k === i ? { ...x, alloc: e.target.value } : x)))} />
              <button type="button" aria-label="Remove pool" style={{ ...select, padding: '0.3rem', cursor: 'pointer' }} onClick={() => setRows(list => list.filter((_, k) => k !== i))}><Trash2 size={14} /></button>
            </div>
          ))}
          <div style={{ ...muted, fontSize: '0.7rem' }}>Allocation points are relative: a pool&apos;s share of the emission is its points divided by the total. Each pool is one more signature.</div>
        </div>
      )}
      {rows.some(r => FARM_REGISTRY.some(f => f.stakeToken.address.toLowerCase() === r.stakeToken.toLowerCase())) && (
        <Notice tone="warn">The app-default pools stake Quaiswap and Quainance LP tokens, which are other DEXes&apos; pool tokens. That is allowed, but check it is what you intend before signing one transaction per pool.</Notice>
      )}

      <FlowRunner
        flowId="FARM"
        flow={flow}
        configError={error}
        fingerprint={json(cfg)}
        initialCtx={addToExisting && existing ? { EXISTING_FARM: existing } : undefined}
        walletAddress={walletAddress}
        onConnect={onConnect}
        onBusy={setBusy}
      />
    </Modal>
  );
}


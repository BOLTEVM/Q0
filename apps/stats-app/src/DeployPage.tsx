import { useEffect, useState } from 'react';
import { Rocket, Image as ImageIcon, Sparkles, Factory, Sprout, Droplets, ShieldCheck, FileCode2, CheckCircle2, Circle, AlertTriangle, ListChecks } from 'lucide-react';
import { DEPLOYED, quaiRpcCall, EIP1967_IMPLEMENTATION_SLOT, type PoolInfo, type DeployedAddresses } from 'quai-service';
import { makeReader, verifyCode, verifyProxy, inspectAmm, renderDeployedTs, checksum, type CircleswapArtifactName, type IntegrityReport } from 'quai-service/deploy';
import { readLocalDeployments, clearLocalDeployments } from 'quai-service/bootstrap';
import { DeployQrbModal, DeployAmmModal, DeployFarmModal } from './DeployModals';
import ArtworkModal from './ArtworkModal';
import GovernanceModal from './GovernanceModal';
import { loadArtwork, type SavedArtwork } from './artwork';
import { Badge, AddrLink, CopyButton, Notice, Spinner, muted, smallBtn, box } from './ui';

type AddressKey = Exclude<keyof DeployedAddresses, 'ARTWORK_URI'>;
const ROWS: { key: AddressKey; label: string; contract: CircleswapArtifactName }[] = [
  { key: 'QRB', label: 'Qrb (ERC-20)', contract: 'Qrb' },
  { key: 'QRB_NFT', label: 'Qrb artifact NFT', contract: 'QrbArtifactNFT' },
  { key: 'AMM_FACTORY', label: 'AMM factory (ERC1967Proxy -> CircleswapFactory)', contract: 'CircleswapFactory' },
  { key: 'AMM_ROUTER', label: 'AMM router (ERC1967Proxy -> CircleswapRouter)', contract: 'CircleswapRouter' },
  { key: 'MASTERCHEF', label: 'Farm (MasterChef)', contract: 'CircleswapMasterChef' }
];

type Check = { state: 'idle' | 'checking' | 'ok' | 'bad'; detail?: string };

interface Props {
  walletAddress: string | null;
  onConnect: () => void;
  /** Every pool the app knows, to offer as farm pools. */
  pools: PoolInfo[];
  onOpenLiquidity: () => void;
}

type Open = null | 'ARTWORK' | 'QRB' | 'AMM' | 'FARM' | 'GOV';

export default function DeployPage({ walletAddress, onConnect, pools, onOpenLiquidity }: Props) {
  const [open, setOpen] = useState<Open>(null);
  const [artwork, setArtwork] = useState<SavedArtwork | null>(() => loadArtwork());
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);
  const [integrityError, setIntegrityError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const local = readLocalDeployments();

  const activeAddress = (key: AddressKey): string | null => DEPLOYED[key] ?? local?.values[key] ?? null;
  const factoryAddress = activeAddress('AMM_FACTORY');
  const routerAddress = activeAddress('AMM_ROUTER');

  // Who can change what, read from the chain whenever the page opens or the AMM changes: the verdict is never taken from this app's records.
  const inspect = async () => {
    if (!factoryAddress) {
      setIntegrity(null);
      return;
    }
    setInspecting(true);
    setIntegrityError(null);
    try {
      setIntegrity(await inspectAmm(makeReader((m, p) => quaiRpcCall(m, p as any[])), { factory: factoryAddress, router: routerAddress }));
    } catch (e: any) {
      setIntegrity(null);
      setIntegrityError(e?.message ?? 'The check could not run.');
    } finally {
      setInspecting(false);
    }
  };
  useEffect(() => {
    void inspect();
  }, [factoryAddress, routerAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  const origin = (key: AddressKey): 'local' | 'file' | null => {
    const v = activeAddress(key);
    if (!v) return null;
    return local?.values[key]?.toLowerCase() === v.toLowerCase() ? 'local' : 'file';
  };

  const verifyAll = async () => {
    void inspect();
    const reader = makeReader((m, p) => quaiRpcCall(m, p as any[]));
    setChecks(Object.fromEntries(ROWS.filter(r => activeAddress(r.key)).map(r => [r.key, { state: 'checking' } as Check])));
    for (const r of ROWS) {
      const address = activeAddress(r.key);
      if (!address) continue;
      try {
        if (r.key === 'AMM_FACTORY' || r.key === 'AMM_ROUTER') {
          const rawImpl = await reader.getStorageAt(checksum(address), EIP1967_IMPLEMENTATION_SLOT);
          if (!rawImpl || rawImpl === '0x' || rawImpl === '0x' + '00'.repeat(32)) {
            throw new Error('EIP-1967 implementation slot is empty');
          }
          const implAddress = checksum('0x' + rawImpl.slice(-40));
          await verifyProxy(reader, r.contract, checksum(address), implAddress);
        } else {
          await verifyCode(reader, r.contract, checksum(address));
        }
        setChecks(c => ({ ...c, [r.key]: { state: 'ok' } }));
      } catch (e: any) {
        setChecks(c => ({ ...c, [r.key]: { state: 'bad', detail: e?.message ?? 'check failed' } }));
      }
    }
  };

  const hasAny = ROWS.some(r => activeAddress(r.key));
  const rendered = (() => {
    try {
      const values: DeployedAddresses = {
        QRB: activeAddress('QRB'),
        QRB_NFT: activeAddress('QRB_NFT'),
        MASTERCHEF: activeAddress('MASTERCHEF'),
        AMM_FACTORY: activeAddress('AMM_FACTORY'),
        AMM_ROUTER: activeAddress('AMM_ROUTER'),
        ARTWORK_URI: DEPLOYED.ARTWORK_URI ?? local?.values.ARTWORK_URI ?? artwork?.uri ?? null
      };
      return renderDeployedTs(values);
    } catch {
      return null;
    }
  })();

  const days = (s?: number) => (s ? s / 86_400 : 0);
  const poolsFrozen = integrity?.facts.pairBeaconOwner?.toLowerCase() === '0x0000000000000000000000000000000000000000';
  type Item = { title: string; detail: string; state: 'done' | 'todo' | 'warn'; optional?: boolean; action?: { label: string; run: () => void } };
  // The go-live list: each line is computed from the chain or from what is recorded, never ticked by hand.
  const checklist: Item[] = [
    { title: 'Artwork on Arweave and verified', state: artwork?.verifiedAt ? 'done' : 'todo', detail: artwork?.verifiedAt ? `${artwork.name} serves exactly the chosen file.` : 'The link is permanent once deployed.', action: artwork?.verifiedAt ? undefined : { label: 'Open', run: () => setOpen('ARTWORK') } },
    { title: 'Qrb and the artifact NFT deployed', state: activeAddress('QRB') && activeAddress('QRB_NFT') ? 'done' : 'todo', detail: activeAddress('QRB') ? 'Both are recorded.' : 'Deploy them first so the farm can use the boost.', action: activeAddress('QRB') ? undefined : { label: 'Open', run: () => setOpen('QRB') } },
    {
      title: 'AMM deployed, and verified from the chain',
      state: !factoryAddress ? 'todo' : integrity && integrity.verdict !== 'UNSAFE' ? 'done' : integrity ? 'warn' : 'todo',
      detail: !factoryAddress ? 'Deploy the timelock, factory and router.' : integrity ? integrity.summary : inspecting ? 'Reading the chain…' : (integrityError ?? 'Not checked yet.'),
      action: !factoryAddress ? { label: 'Deploy', run: () => setOpen('AMM') } : { label: 'Open governance', run: () => setOpen('GOV') }
    },
    {
      title: 'Proposer is a multisig and the delay is at least two days',
      state: !integrity ? 'todo' : days(integrity.facts.timelockDelaySeconds) >= 2 ? 'done' : 'warn',
      detail: !integrity ? 'Read from the chain once the AMM exists.' : `The delay is ${days(integrity.facts.timelockDelaySeconds)} day(s). Who holds the proposer role cannot be listed from the chain: confirm it is your multisig in Governance.`
    },
    {
      title: 'AMM addresses committed to deployed.ts',
      state: !factoryAddress ? 'todo' : origin('AMM_FACTORY') === 'file' && origin('AMM_ROUTER') === 'file' ? 'done' : 'warn',
      detail: !factoryAddress ? 'After deploying.' : origin('AMM_FACTORY') === 'file' && origin('AMM_ROUTER') === 'file' ? 'Every visitor gets the AMM.' : 'They live only in this browser. Copy deployed.ts below, commit it and rebuild, or visitors will not see the AMM.'
    },
    { title: 'First pools created', state: integrity && integrity.facts.pools.total > 0 ? 'done' : 'todo', detail: integrity && integrity.facts.pools.total > 0 ? `${integrity.facts.pools.total} pool(s). ` + (integrity.facts.pools.foreign ? `${integrity.facts.pools.foreign} outside the factory's governance: see Governance.` : '') : 'Seed them at the market ratio: the first deposit sets the price.', action: factoryAddress ? { label: 'Create / manage pools', run: onOpenLiquidity } : undefined },
    { title: 'Pool code frozen', optional: true, state: poolsFrozen ? 'done' : 'todo', detail: poolsFrozen ? 'Nobody can ever change existing pools.' : 'When the pool code is final, this makes every existing pool untouchable. Irreversible; it also means a pool bug could never be fixed in those pools.', action: factoryAddress && !poolsFrozen ? { label: 'Open governance', run: () => setOpen('GOV') } : undefined },
    { title: 'Router permanent', optional: true, state: integrity?.facts.routerOwnerKind === 'renounced' ? 'done' : 'todo', detail: integrity?.facts.routerOwnerKind === 'renounced' ? 'The router can never be replaced.' : 'Users approve tokens to the router, so its upgrades are the sensitive ones. Making it permanent removes that power for good.', action: factoryAddress && integrity?.facts.routerOwnerKind !== 'renounced' ? { label: 'Open governance', run: () => setOpen('GOV') } : undefined },
    { title: 'Farm deployed and funded', state: activeAddress('MASTERCHEF') ? 'done' : 'todo', detail: activeAddress('MASTERCHEF') ? 'Recorded. It pays rewards only from its own BDELTA / Q0 balance: fund it.' : 'Dual-reward farm with the Qrb boost.', action: activeAddress('MASTERCHEF') ? undefined : { label: 'Open', run: () => setOpen('FARM') } }
  ];

  const card = (icon: React.ReactNode, title: string, status: React.ReactNode, body: string, action: React.ReactNode) => (
    <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{icon} {title}</div>
        {status}
      </div>
      <div style={{ ...muted, fontSize: '0.8rem', lineHeight: 1.5, flex: 1 }}>{body}</div>
      {action}
    </div>
  );

  const done = (k: AddressKey) => (activeAddress(k) ? <Badge severity="info">Deployed</Badge> : <Badge severity="neutral">Not deployed</Badge>);

  return (
    <div style={{ marginBottom: '3rem' }}>
      <div className="section-title" style={{ marginBottom: '0.75rem' }}>
        <Rocket size={22} style={{ color: 'var(--accent-plasma)' }} /> Deploy Circleswap
      </div>
      <Notice tone="info">
        These steps are signed in <strong>your wallet</strong>: the app never sees a key. Each transaction is simulated first, shown to you with its worst-case fee, and only then sent to
        the wallet. Every contract&apos;s address is taken from its receipt and checked on chain (code, owner, settings) before the next step. Recommended order: artwork → Qrb &amp; NFT → AMM →
        first pool → farm → fund the farm.
      </Notice>
      <Notice tone="warn">
        Deployment spends real QUAI and is permanent. Quai&apos;s simulator is an unreliable guide to what a creation costs (real use has ranged from about 0.4× to 2.5× its figure), so gas limits are set wide;
        unused gas is refunded when a transaction succeeds, but one that runs out of gas or reverts uses its whole limit. The same deployment is also available from the command line
        (<code>pnpm --filter contracts deploy:quai -- --amm</code>, see DEPLOY.md), which runs the identical plan and the identical launch checks.
      </Notice>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem', marginBottom: '1.25rem' }}>
        {card(
          <ImageIcon size={18} style={{ color: 'var(--accent-plasma)' }} />,
          '1. Artwork',
          artwork ? <Badge severity={artwork.verifiedAt ? 'info' : 'warn'}>{artwork.verifiedAt ? 'Verified' : 'Unverified'}</Badge> : <Badge severity="neutral">Not set</Badge>,
          artwork ? `${artwork.name} at ${artwork.uri.slice(0, 18)}…` : 'Choose the file, upload it to Arweave, and prove the address serves exactly that file. The link is permanent once deployed.',
          <button type="button" className="btn-primary" style={{ minHeight: 40 }} onClick={() => setOpen('ARTWORK')}>{artwork ? 'Review artwork' : 'Set up artwork'}</button>
        )}
        {card(
          <Sparkles size={18} style={{ color: 'var(--accent-plasma)' }} />,
          '2. Qrb & NFT',
          done('QRB'),
          'Fixed 1.0 supply ERC-20 that gives the farm boost, and the 1-of-1 artifact NFT with a 5% royalty.',
          <button type="button" className="btn-primary" style={{ minHeight: 40 }} onClick={() => setOpen('QRB')}>{activeAddress('QRB') ? 'Open (already deployed)' : 'Deploy Qrb & NFT'}</button>
        )}
        {card(
          <Factory size={18} style={{ color: 'var(--accent-plasma)' }} />,
          '3. AMM',
          done('AMM_ROUTER'),
          'A timelock, the factory and the router, upgradable only through the timelock\'s public delay. Anyone can create pools once the factory exists.',
          <button type="button" className="btn-primary" style={{ minHeight: 40 }} onClick={() => setOpen('AMM')}>{activeAddress('AMM_ROUTER') ? 'Open (already deployed)' : 'Deploy AMM'}</button>
        )}
        {card(
          <Droplets size={18} style={{ color: 'var(--accent-plasma)' }} />,
          '4. Pools & liquidity',
          activeAddress('AMM_ROUTER') ? <Badge severity="info">Ready</Badge> : <Badge severity="neutral">Needs the AMM</Badge>,
          'Create a pool by seeding it with both tokens, and add or remove liquidity. Pools on Quaiswap and Quainance can be created here too.',
          <button type="button" className="btn-primary" style={{ minHeight: 40 }} onClick={onOpenLiquidity}>Create / manage pools</button>
        )}
        {card(
          <Sprout size={18} style={{ color: 'var(--accent-plasma)' }} />,
          '5. Farm',
          done('MASTERCHEF'),
          'Dual-reward farm with the Qrb boost. Deploy it, add pools, then send it the BDELTA and Q0 it will pay out.',
          <button type="button" className="btn-primary" style={{ minHeight: 40 }} onClick={() => setOpen('FARM')}>{activeAddress('MASTERCHEF') ? 'Add pools / open' : 'Deploy farm'}</button>
        )}
        {card(
          <ShieldCheck size={18} style={{ color: 'var(--accent-plasma)' }} />,
          '6. Governance & integrity',
          !factoryAddress ? <Badge severity="neutral">Needs the AMM</Badge>
            : inspecting && !integrity ? <Badge severity="neutral">Checking…</Badge>
            : integrity ? <Badge severity={integrity.verdict === 'UNSAFE' ? 'danger' : 'ok'} title={integrity.summary}>{integrity.verdict === 'UNSAFE' ? 'Unsafe' : integrity.verdict === 'IMMUTABLE_POOLS' ? 'Pools immutable' : `Governed${integrity.facts.timelockDelaySeconds ? ` · ${integrity.facts.timelockDelaySeconds / 86_400}d` : ''}`}</Badge>
            : <Badge severity="warn">Check failed</Badge>,
          'Verify from the chain who can upgrade what and how fast, see every pending change, queue new ones, rotate keys, and freeze pool code forever once it is final.',
          <button type="button" className="btn-primary" style={{ minHeight: 40 }} onClick={() => setOpen('GOV')}>Open governance</button>
        )}
      </div>

      <div className="glass-card" style={{ marginBottom: '1.25rem' }}>
        <div style={{ fontWeight: 800, fontFamily: 'var(--font-display)', display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.6rem' }}><ListChecks size={18} /> Launch checklist</div>
        {checklist.map(item => (
          <div key={item.title} style={{ display: 'flex', gap: '0.55rem', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
            {item.state === 'done' ? <CheckCircle2 size={16} style={{ color: 'var(--success)', flexShrink: 0, marginTop: 1 }} />
              : item.state === 'warn' ? <AlertTriangle size={16} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
              : <Circle size={16} style={{ color: 'var(--text-dim)', flexShrink: 0, marginTop: 1 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: '0.82rem' }}>{item.title}{item.optional && <span style={{ ...muted, fontWeight: 400 }}> (optional)</span>}</div>
              <div style={{ ...muted, fontSize: '0.74rem' }}>{item.detail}</div>
            </div>
            {item.action && <button type="button" style={smallBtn} onClick={item.action.run}>{item.action.label}</button>}
          </div>
        ))}
      </div>

      <div className="glass-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.6rem' }}>
          <div style={{ fontWeight: 800, fontFamily: 'var(--font-display)', display: 'flex', gap: '0.4rem', alignItems: 'center' }}><ShieldCheck size={18} /> Deployed contracts</div>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            <button type="button" style={smallBtn} onClick={verifyAll} disabled={!hasAny}>Re-verify on chain</button>
            {rendered && hasAny && <CopyButton text={rendered} label="Copy deployed.ts" />}
            {local && Object.keys(local.values).length > 0 && (
              <button type="button" style={smallBtn} onClick={() => { clearLocalDeployments(); window.location.reload(); }}>Forget browser-local deployments</button>
            )}
          </div>
        </div>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr><th>Contract</th><th>Address</th><th>Source</th><th>Check</th></tr>
            </thead>
            <tbody>
              {ROWS.map(r => {
                const v = activeAddress(r.key);
                const c = checks[r.key];
                const o = origin(r.key);
                return (
                  <tr key={r.key}>
                    <td style={{ fontWeight: 700 }}>{r.label}</td>
                    <td>{v ? <AddrLink address={v} /> : <span style={muted}>not deployed</span>}</td>
                    <td>{o === 'local' ? <Badge severity="warn" title="Only in this browser. Commit it to deployed.ts to make it permanent.">This browser</Badge> : o === 'file' ? <Badge severity="neutral">deployed.ts</Badge> : <span style={muted}>—</span>}</td>
                    <td>
                      {c?.state === 'checking' && <Spinner />}
                      {c?.state === 'ok' && <Badge severity="info">Code matches</Badge>}
                      {c?.state === 'bad' && <span title={c.detail}><Badge severity="danger">Mismatch</Badge></span>}
                    </td>
                  </tr>
                );
              })}
              {factoryAddress && (
                <>
                  <tr>
                    <td style={{ fontWeight: 700 }}>Timelock (owner)</td>
                    <td>{integrity?.facts.owner && integrity.facts.ownerKind === 'timelock' ? <AddrLink address={integrity.facts.owner} /> : <span style={muted}>{integrity?.facts.ownerKind === 'renounced' ? 'nobody: renounced' : integrity ? 'not a Circleswap timelock' : inspecting ? 'reading…' : '—'}</span>}</td>
                    <td><Badge severity="neutral" title="Read from the chain, not stored">From chain</Badge></td>
                    <td>{integrity?.facts.ownerKind === 'timelock' && integrity.facts.timelockDelaySeconds ? <Badge severity="ok">{integrity.facts.timelockDelaySeconds / 86_400}-day delay</Badge> : integrity ? <Badge severity={integrity.facts.ownerKind === 'renounced' ? 'ok' : 'danger'}>{integrity.facts.ownerKind === 'renounced' ? 'Permanent' : 'Check owner'}</Badge> : null}</td>
                  </tr>
                  <tr>
                    <td style={{ fontWeight: 700 }}>Pool beacon (every pool follows it)</td>
                    <td>{integrity?.facts.pairBeacon ? <AddrLink address={integrity.facts.pairBeacon} /> : <span style={muted}>{inspecting ? 'reading…' : '—'}</span>}</td>
                    <td><Badge severity="neutral" title="Read from the chain, not stored">From chain</Badge></td>
                    <td>{integrity?.facts.pairBeaconOwner ? (integrity.facts.pairBeaconOwner.toLowerCase() === '0x0000000000000000000000000000000000000000' ? <Badge severity="ok">Frozen forever</Badge> : <Badge severity="info">Upgradable via timelock</Badge>) : null}</td>
                  </tr>
                  <tr>
                    <td style={{ fontWeight: 700 }}>Pool implementation</td>
                    <td>{integrity?.facts.pairImpl ? <AddrLink address={integrity.facts.pairImpl} /> : <span style={muted}>{inspecting ? 'reading…' : '—'}</span>}</td>
                    <td><Badge severity="neutral" title="Read from the chain, not stored">From chain</Badge></td>
                    <td>{integrity ? <Badge severity={integrity.checks.find(c => c.id === 'pair.code')?.level === 'pass' ? 'ok' : 'danger'}>{integrity.checks.find(c => c.id === 'pair.code')?.level === 'pass' ? 'Code matches' : 'Mismatch'}</Badge> : null}</td>
                  </tr>
                </>
              )}
              {integrityError && <tr><td colSpan={4} style={{ color: 'var(--error)', fontSize: '0.78rem' }}>The governance check could not run: {integrityError}</td></tr>}
              <tr>
                <td style={{ fontWeight: 700 }}>Artwork URI</td>
                <td colSpan={3} style={{ fontSize: '0.78rem', wordBreak: 'break-all' }}>{DEPLOYED.ARTWORK_URI ?? local?.values.ARTWORK_URI ?? artwork?.uri ?? <span style={muted}>—</span>}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {local && Object.keys(local.values).length > 0 && (
          <div style={{ ...box, marginTop: '0.75rem', fontSize: '0.78rem', display: 'flex', gap: '0.4rem' }}>
            <FileCode2 size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>
              Some addresses are remembered only in this browser. They are re-checked on chain each time the app starts (a contract must exist and be exactly the compiled one) and dropped if not.
              To make them permanent, replace <code>packages/quai-service/src/registries/deployed.ts</code> with the copied text.
            </span>
          </div>
        )}
      </div>

      {open === 'ARTWORK' && <ArtworkModal onClose={() => setOpen(null)} onChanged={setArtwork} />}
      {open === 'QRB' && <DeployQrbModal walletAddress={walletAddress} onConnect={onConnect} onClose={() => setOpen(null)} onOpenArtwork={() => setOpen('ARTWORK')} artwork={artwork} />}
      {open === 'AMM' && <DeployAmmModal walletAddress={walletAddress} onConnect={onConnect} onClose={() => setOpen(null)} onOpenGovernance={() => setOpen('GOV')} />}
      {open === 'GOV' && <GovernanceModal walletAddress={walletAddress} onConnect={onConnect} onClose={() => setOpen(null)} />}
      {open === 'FARM' && <DeployFarmModal walletAddress={walletAddress} onConnect={onConnect} onClose={() => setOpen(null)} pools={pools} />}
    </div>
  );
}

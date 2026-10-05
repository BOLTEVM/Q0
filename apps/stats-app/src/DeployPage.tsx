import { useState } from 'react';
import { Rocket, Image as ImageIcon, Sparkles, Factory, Sprout, Droplets, ShieldCheck, FileCode2 } from 'lucide-react';
import { DEPLOYED, quaiRpcCall, EIP1967_IMPLEMENTATION_SLOT, type PoolInfo, type DeployedAddresses } from 'quai-service';
import { makeReader, verifyCodeSize, verifyProxy, renderDeployedTs, checksum, type CircleswapArtifactName } from 'quai-service/deploy';
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
  const local = readLocalDeployments();

  const activeAddress = (key: AddressKey): string | null => DEPLOYED[key] ?? local?.values[key] ?? null;

  const origin = (key: AddressKey): 'local' | 'file' | null => {
    const v = activeAddress(key);
    if (!v) return null;
    return local?.values[key]?.toLowerCase() === v.toLowerCase() ? 'local' : 'file';
  };

  const verifyAll = async () => {
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
          await verifyCodeSize(reader, r.contract, checksum(address));
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
        Deployment spends real QUAI and is permanent. A creation costs roughly 2.5× what the simulator estimates, so gas limits are set wide; unused gas is refunded when a transaction succeeds, but a
        transaction that reverts uses its whole limit. The same deployment is also available from the command line (<code>pnpm --filter contracts deploy:quai</code>, see DEPLOY.md).
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
          activeAddress('AMM_FACTORY') ? <Badge severity="info">Live checks</Badge> : <Badge severity="neutral">Needs the AMM</Badge>,
          'Verify from the chain who can upgrade what and how fast, see every pending change, queue new ones, and freeze pool code forever once it is final.',
          <button type="button" className="btn-primary" style={{ minHeight: 40 }} onClick={() => setOpen('GOV')}>Open governance</button>
        )}
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

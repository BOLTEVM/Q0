import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck, ShieldAlert, ShieldQuestion, RefreshCw, Clock, Send } from 'lucide-react';
import { DEPLOYED, quaiRpcCall, prepareContractCall, waitForReceipt, getLatestBlockNumber, createBatch } from 'quai-service';
import {
  makeReader,
  inspectAmm,
  listOperations,
  describeCall,
  OPS,
  scheduleTx,
  executeTx,
  cancelTx,
  type IntegrityReport,
  type QueuedOp,
  type GovOp,
  type GovTargets,
  type Check
} from 'quai-service/deploy';
import { getQuaiProvider, sendWalletTransaction } from './providerUtils';
import { Modal, Notice, Badge, AddrLink, CopyButton, Spinner, Field, input, box, muted, smallBtn, row } from './ui';

type Tab = 'INTEGRITY' | 'QUEUE' | 'PROPOSE';
const LOOKBACK_BLOCKS = 200_000; // ~11 days of zone blocks at 5 s; the node serves 10,000 per log query
const SALTS_KEY = 'q0.gov.salts.v1';

const reader = makeReader((m, p) => quaiRpcCall(m, p as any[]));
const rank: Record<Check['level'], number> = { fail: 0, warn: 1, info: 2, pass: 3 };
const LEVEL_COLOR: Record<Check['level'], string> = { fail: 'var(--error)', warn: 'var(--warning)', info: 'var(--accent-neon)', pass: 'var(--success)' };

function loadSalts(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SALTS_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function rememberSalt(id: string, salt: string) {
  try {
    localStorage.setItem(SALTS_KEY, JSON.stringify({ ...loadSalts(), [id]: salt }));
  } catch {
    /* storage blocked: the salt is also readable from the scheduling transaction */
  }
}

const countdown = (readyAt: number, now: number) => {
  const d = readyAt - now;
  if (d <= 0) return 'ready';
  if (d < 3600) return `${Math.ceil(d / 60)} min`;
  if (d < 86400) return `${(d / 3600).toFixed(1)} h`;
  return `${(d / 86400).toFixed(1)} days`;
};

interface Props {
  walletAddress: string | null;
  onConnect: () => void;
  onClose: () => void;
}

export default function GovernanceModal({ walletAddress, onConnect, onClose }: Props) {
  const factory = DEPLOYED.AMM_FACTORY;
  const router = DEPLOYED.AMM_ROUTER;
  const [tab, setTab] = useState<Tab>('INTEGRITY');
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [ops, setOps] = useState<QueuedOp[] | null>(null);
  const [loadingOps, setLoadingOps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyTx, setBusyTx] = useState<string | null>(null);
  const [isProposer, setIsProposer] = useState(false);
  const alive = useRef(true);
  // Set true on every mount: StrictMode unmounts and remounts once, and the cleanup must not leave this false.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const timelock = report?.facts.ownerKind === 'timelock' ? report.facts.owner ?? null : null;
  const targets: GovTargets | null = factory && timelock ? { factory, router, timelock } : null;

  const check = useCallback(async () => {
    if (!factory) return;
    setChecking(true);
    setError(null);
    try {
      const r = await inspectAmm(reader, { factory, router });
      if (alive.current) setReport(r);
    } catch (e: any) {
      if (alive.current) setError(e?.message ?? String(e));
    } finally {
      if (alive.current) setChecking(false);
    }
  }, [factory, router]);

  useEffect(() => { check(); }, [check]);

  const loadOps = useCallback(async () => {
    if (!timelock) return;
    setLoadingOps(true);
    try {
      const head = await getLatestBlockNumber();
      const list = await listOperations(reader, createBatch(), timelock, head, LOOKBACK_BLOCKS);
      const salts = loadSalts();
      if (alive.current) setOps(list.map(o => ({ ...o, salt: o.salt ?? salts[o.id] })));
    } catch (e: any) {
      if (alive.current) setError(e?.message ?? String(e));
    } finally {
      if (alive.current) setLoadingOps(false);
    }
  }, [timelock]);

  useEffect(() => { if (tab === 'QUEUE' || tab === 'PROPOSE') loadOps(); }, [tab, loadOps]);

  // Is the connected wallet a proposer? (Only proposers can queue or cancel; execution is open unless configured otherwise.)
  useEffect(() => {
    if (!timelock || !walletAddress) { setIsProposer(false); return; }
    (async () => {
      try {
        const { interfaceOf } = await import('quai-service/deploy');
        const iface = interfaceOf('CircleswapTimelock');
        const role = iface.decodeFunctionResult('PROPOSER_ROLE', await reader.call(timelock, iface.encodeFunctionData('PROPOSER_ROLE')))[0];
        const has = iface.decodeFunctionResult('hasRole', await reader.call(timelock, iface.encodeFunctionData('hasRole', [role, walletAddress])))[0];
        if (alive.current) setIsProposer(Boolean(has));
      } catch {
        if (alive.current) setIsProposer(false);
      }
    })();
  }, [timelock, walletAddress]);

  const send = async (label: string, tx: { to: string; data: string }) => {
    const provider = getQuaiProvider();
    if (!walletAddress || !provider) { setError('Connect a Quai wallet first.'); return false; }
    setBusyTx(label);
    setError(null);
    try {
      // Simulated first (a revert on Quai burns the whole gas limit), with the access list the zone requires.
      const prepared = await prepareContractCall(walletAddress, tx.to, tx.data, 1.5);
      const hash = await sendWalletTransaction(provider, prepared.tx);
      await waitForReceipt(hash);
      return true;
    } catch (e: any) {
      setError(e?.message ?? String(e));
      return false;
    } finally {
      if (alive.current) setBusyTx(null);
    }
  };

  const now = Math.floor(Date.now() / 1000);
  const delayText = report?.facts.timelockDelaySeconds ? `${report.facts.timelockDelaySeconds / 86_400} days` : '—';

  if (!factory) {
    return (
      <Modal title="Governance & integrity" icon={<ShieldCheck size={20} style={{ color: 'var(--accent-plasma)' }} />} onClose={onClose}>
        <Notice tone="info">The AMM is not deployed yet (or not recorded in this browser). Deploy it first, then come back to check and govern it.</Notice>
      </Modal>
    );
  }

  const verdictTone = report?.verdict === 'UNSAFE' ? 'danger' : report?.verdict === 'IMMUTABLE_POOLS' ? 'ok' : 'warn';
  const VerdictIcon = report?.verdict === 'UNSAFE' ? ShieldAlert : report ? ShieldCheck : ShieldQuestion;

  return (
    <Modal title="Governance & integrity" icon={<ShieldCheck size={20} style={{ color: 'var(--accent-plasma)' }} />} onClose={onClose} locked={busyTx !== null} maxWidth={760}>
      <div role="tablist" style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem' }}>
        {([['INTEGRITY', 'Integrity check'], ['QUEUE', 'Pending changes'], ['PROPOSE', 'Propose a change']] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)} style={{ ...smallBtn, flex: 1, justifyContent: 'center', borderColor: tab === k ? 'var(--accent-plasma)' : 'var(--panel-border)', background: tab === k ? 'rgba(255, 51, 68, 0.12)' : smallBtn.background }}>
            {label}
          </button>
        ))}
      </div>

      {error && <Notice tone="danger">{error}</Notice>}

      {tab === 'INTEGRITY' && (
        <div>
          <div style={{ ...row, alignItems: 'center', marginBottom: '0.6rem' }}>
            <div style={{ ...muted, fontSize: '0.78rem' }}>Read from the chain just now. Nothing here is taken from this app&apos;s own records.</div>
            <button type="button" style={smallBtn} onClick={check} disabled={checking}>{checking ? <Spinner /> : <RefreshCw size={12} />} Re-check</button>
          </div>
          {!report && checking && <div style={{ padding: '1.5rem', textAlign: 'center' }}><Spinner /> Inspecting the proxies, the timelock, the pool beacon and every pool…</div>}
          {report && (
            <>
              <Notice tone={verdictTone}>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontWeight: 800, marginBottom: '0.25rem' }}>
                  <VerdictIcon size={18} />
                  {report.verdict === 'IMMUTABLE_POOLS' ? 'Existing pools are permanent' : report.verdict === 'GOVERNED' ? 'Every change is public and delayed' : 'Not safe: read the failures below'}
                </div>
                {report.summary}
              </Notice>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.6rem', marginBottom: '0.9rem' }}>
                <div style={box}><div style={{ ...muted, fontSize: '0.7rem' }}>OWNER</div><div style={{ fontWeight: 700 }}>{report.facts.ownerKind === 'timelock' ? `Timelock · ${delayText}` : report.facts.ownerKind === 'renounced' ? 'Nobody (permanent)' : report.facts.ownerKind === 'account' ? 'A single account' : report.facts.ownerKind === 'contract' ? 'Unknown contract' : '—'}</div>{report.facts.owner && <AddrLink address={report.facts.owner} />}</div>
                <div style={box}><div style={{ ...muted, fontSize: '0.7rem' }}>POOL CODE</div><div style={{ fontWeight: 700 }}>{report.facts.pairBeaconOwner && report.facts.pairBeaconOwner.toLowerCase() === '0x0000000000000000000000000000000000000000' ? 'Frozen forever' : 'Upgradable via timelock'}</div>{report.facts.pairImpl && <AddrLink address={report.facts.pairImpl} />}</div>
                <div style={box}><div style={{ ...muted, fontSize: '0.7rem' }}>POOLS EXAMINED</div><div style={{ fontWeight: 700 }}>{report.facts.pools.checked} of {report.facts.pools.total}</div><div style={{ ...muted, fontSize: '0.72rem' }}>{report.facts.pools.frozen} frozen · {report.facts.pools.governed} timelocked · {report.facts.pools.foreign} outside</div></div>
              </div>

              <div className="table-wrapper">
                <table>
                  <tbody>
                    {[...report.checks].sort((a, b) => rank[a.level] - rank[b.level]).map(c => (
                      <tr key={c.id}>
                        <td style={{ width: 70 }}><span style={{ color: LEVEL_COLOR[c.level], fontWeight: 800, fontSize: '0.7rem', textTransform: 'uppercase' }}>{c.level}</span></td>
                        <td>
                          <div style={{ fontWeight: 700, fontSize: '0.82rem' }}>{c.title}</div>
                          <div style={{ ...muted, fontSize: '0.74rem', wordBreak: 'break-word' }}>{c.detail}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'QUEUE' && (
        <div>
          {!targets && <Notice tone="warn">The owner is not a Circleswap timelock, so there is no public queue to show. {report?.facts.ownerKind === 'account' ? 'Changes by that account are not announced at all.' : ''}</Notice>}
          {targets && (
            <>
              <div style={{ ...row, alignItems: 'center', marginBottom: '0.6rem' }}>
                <div style={{ ...muted, fontSize: '0.78rem' }}>Everything scheduled on the timelock in the last ~{Math.round((LOOKBACK_BLOCKS * 5) / 86400)} days. A change cannot run before its time, and the proposer can cancel it.</div>
                <button type="button" style={smallBtn} onClick={loadOps} disabled={loadingOps}>{loadingOps ? <Spinner /> : <RefreshCw size={12} />} Refresh</button>
              </div>
              {ops === null && loadingOps && <div style={{ padding: '1.5rem', textAlign: 'center' }}><Spinner /> Reading the timelock…</div>}
              {ops && ops.length === 0 && <div style={{ ...muted, padding: '1rem' }}>Nothing has been scheduled recently.</div>}
              {ops?.map(o => {
                const text = describeCall(o.target, o.data, targets);
                const sensitive = /UPGRADE EVERY POOL|Upgrade the router|Upgrade the factory/.test(text);
                const active = o.state === 'WAITING' || o.state === 'READY';
                return (
                  <div key={o.id} style={{ ...box, marginBottom: '0.5rem', borderColor: active && sensitive ? 'var(--warning)' : 'var(--panel-border)' }}>
                    <div style={{ ...row, alignItems: 'center' }}>
                      <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>{text}</div>
                      <Badge severity={o.state === 'READY' ? 'warn' : o.state === 'WAITING' ? 'info' : 'neutral'}>{o.state}</Badge>
                    </div>
                    <div style={{ ...muted, fontSize: '0.72rem', marginTop: 2 }}>
                      {active && <><Clock size={11} style={{ verticalAlign: 'middle' }} /> {o.state === 'READY' ? 'can run now' : `runs in ${countdown(o.readyAt, now)}`} · </>}
                      id {o.id.slice(0, 10)}… {o.scheduleTx && <>· scheduled in <AddrLink address={o.scheduleTx} tx /></>}
                    </div>
                    {active && sensitive && <div style={{ color: 'var(--warning)', fontSize: '0.74rem', marginTop: 3 }}>Review the new code before this runs. If you do not trust it, remove your liquidity and revoke router approvals before the time above.</div>}
                    {active && (
                      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
                        {o.state === 'READY' && (
                          <button type="button" style={smallBtn} disabled={!o.salt || busyTx !== null} title={o.salt ? undefined : 'The salt is unknown (scheduled through another contract): only its proposer can execute it'} onClick={async () => { if (o.salt && await send('execute', executeTx(targets.timelock, o.target, o.data, o.salt))) { loadOps(); check(); } }}>
                            {busyTx === 'execute' ? <Spinner /> : <Send size={12} />} Execute
                          </button>
                        )}
                        <button type="button" style={smallBtn} disabled={!isProposer || busyTx !== null} title={isProposer ? undefined : 'Only a proposer can cancel'} onClick={async () => { if (await send('cancel', cancelTx(targets.timelock, o.id))) loadOps(); }}>
                          {busyTx === 'cancel' ? <Spinner /> : null} Cancel
                        </button>
                        <CopyButton text={JSON.stringify({ to: targets.timelock, id: o.id, target: o.target, data: o.data, salt: o.salt ?? null })} label="Copy details" />
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {tab === 'PROPOSE' && (
        <Propose targets={targets} delaySeconds={report?.facts.timelockDelaySeconds ?? 0} walletAddress={walletAddress} onConnect={onConnect} isProposer={isProposer} busy={busyTx !== null} onSend={async (_op, tx, salt, id) => { const ok = await send('schedule', tx); if (ok) { rememberSalt(id, salt); loadOps(); } return ok; }} />
      )}
    </Modal>
  );
}

type Kind = keyof typeof OPS;
const KINDS: { kind: Kind; label: string; arg?: { label: string; placeholder: string } }[] = [
  { kind: 'setFeeTo', label: 'Set the protocol fee recipient', arg: { label: 'Recipient (blank turns the fee off)', placeholder: '0x00…' } },
  { kind: 'upgradePools', label: 'Upgrade every pool (reaches liquidity)', arg: { label: 'New pool implementation', placeholder: '0x00…' } },
  { kind: 'freezePools', label: 'Freeze pool upgrades forever' },
  { kind: 'newPoolVersion', label: 'New pools follow a new beacon', arg: { label: 'Beacon (owned by the factory)', placeholder: '0x00…' } },
  { kind: 'upgradeRouter', label: 'Upgrade the router', arg: { label: 'New router implementation', placeholder: '0x00…' } },
  { kind: 'upgradeFactory', label: 'Upgrade the factory', arg: { label: 'New factory implementation', placeholder: '0x00…' } },
  { kind: 'makeRouterPermanent', label: 'Make the router permanent' },
  { kind: 'makeFactoryPermanent', label: 'Make the factory permanent' },
  { kind: 'updateDelay', label: 'Change the timelock delay', arg: { label: 'New delay in days (1 to 30)', placeholder: '3' } }
];

function Propose({ targets, delaySeconds, walletAddress, onConnect, isProposer, busy, onSend }: {
  targets: GovTargets | null;
  delaySeconds: number;
  walletAddress: string | null;
  onConnect: () => void;
  isProposer: boolean;
  busy: boolean;
  onSend: (op: GovOp, tx: { to: string; data: string }, salt: string, id: string) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<Kind>('setFeeTo');
  const [arg, setArg] = useState('');
  const [ack, setAck] = useState(false);
  const [scheduled, setScheduled] = useState<{ id: string; salt: string } | null>(null);
  const spec = KINDS.find(k => k.kind === kind)!;

  const built = useMemo(() => {
    if (!targets) return { op: null as GovOp | null, error: null as string | null };
    try {
      const t = targets;
      const op =
        kind === 'setFeeTo' ? OPS.setFeeTo(t, arg.trim() || null)
        : kind === 'updateDelay' ? OPS.updateDelay(t, Math.round(Number(arg) * 86_400))
        : kind === 'freezePools' ? OPS.freezePools(t)
        : kind === 'makeRouterPermanent' ? OPS.makeRouterPermanent(t)
        : kind === 'makeFactoryPermanent' ? OPS.makeFactoryPermanent(t)
        : kind === 'upgradePools' ? OPS.upgradePools(t, arg.trim())
        : kind === 'newPoolVersion' ? OPS.newPoolVersion(t, arg.trim())
        : kind === 'upgradeRouter' ? OPS.upgradeRouter(t, arg.trim())
        : OPS.upgradeFactory(t, arg.trim());
      return { op, error: null };
    } catch (e: any) {
      return { op: null, error: arg ? e?.message ?? String(e) : null };
    }
  }, [targets, kind, arg]);

  const prepared = useMemo(() => (built.op && delaySeconds ? scheduleTx(targets!.timelock, built.op, delaySeconds) : null), [built.op, delaySeconds, targets]);
  // A fresh salt per attempt; reset acknowledgement when the operation changes.
  useEffect(() => { setAck(false); setScheduled(null); }, [kind, arg]);

  if (!targets) return <Notice tone="warn">Changes can only be proposed when the owner is a Circleswap timelock.</Notice>;
  const needsAck = built.op && built.op.risk !== 'routine';

  return (
    <div>
      <Notice tone="info">Proposing does not change anything yet: it queues the change publicly. It can run after {delaySeconds / 86_400} days, by anyone, unless a proposer cancels it first.</Notice>
      <Field label="Change">
        <select style={{ ...input, padding: '0.45rem' }} value={kind} onChange={e => { setKind(e.target.value as Kind); setArg(''); }} aria-label="Kind of change">
          {KINDS.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
      </Field>
      {spec.arg && (
        <Field label={spec.arg.label}>
          <input style={input} value={arg} onChange={e => setArg(e.target.value)} placeholder={spec.arg.placeholder} spellCheck={false} aria-label={spec.arg.label} />
        </Field>
      )}
      {built.error && <Notice tone="danger">{built.error}</Notice>}
      {built.op && (
        <>
          <Notice tone={built.op.risk === 'irreversible' ? 'danger' : built.op.risk === 'sensitive' ? 'warn' : 'info'}>
            <strong>{built.op.label}</strong>
            <div style={{ marginTop: 3 }}>{built.op.description}</div>
          </Notice>
          {needsAck && (
            <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', marginBottom: '0.85rem', cursor: 'pointer', fontSize: '0.82rem' }}>
              <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} style={{ marginTop: 3 }} />
              <span>{built.op.risk === 'irreversible' ? 'I understand this cannot be undone once it runs.' : 'I have read the new code, and I understand liquidity providers and users will see this for the whole delay.'}</span>
            </label>
          )}
          {prepared && (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {!walletAddress ? (
                <button type="button" className="btn-primary" style={{ flex: 1, minHeight: 42 }} onClick={onConnect}>Connect wallet</button>
              ) : (
                <button
                  type="button"
                  className="btn-primary"
                  style={{ flex: 1, minHeight: 42 }}
                  disabled={busy || (Boolean(needsAck) && !ack) || !isProposer}
                  title={isProposer ? undefined : 'The connected wallet is not a proposer on this timelock: copy the transaction for your multisig instead'}
                  onClick={async () => { if (await onSend(built.op!, prepared.tx, prepared.salt, prepared.id)) setScheduled({ id: prepared.id, salt: prepared.salt }); }}
                >
                  {busy ? <Spinner /> : null} Queue from this wallet
                </button>
              )}
              <CopyButton text={JSON.stringify({ to: prepared.tx.to, data: prepared.tx.data, value: '0' })} label="Copy transaction for a multisig" />
            </div>
          )}
          {scheduled && <Notice tone="ok">Queued. Operation id <span style={{ fontFamily: 'monospace' }}>{scheduled.id.slice(0, 18)}…</span>. It appears under Pending changes; keep the salt if a multisig will execute it: <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{scheduled.salt}</span></Notice>}
        </>
      )}
    </div>
  );
}

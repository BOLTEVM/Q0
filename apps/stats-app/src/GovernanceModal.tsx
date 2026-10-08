import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck, ShieldAlert, ShieldQuestion, RefreshCw, Clock, Send, CheckCircle2, Circle } from 'lucide-react';
import { DEPLOYED, quaiRpcCall, prepareContractCall, waitForReceipt, getLatestBlockNumber, createBatch } from 'quai-service';
import { readLocalDeployments } from 'quai-service/bootstrap';
import {
  makeReader,
  inspectAmm,
  interfaceOf,
  listOperations,
  describeCall,
  TIMELOCK_ROLES,
  OPS,
  scheduleTx,
  executeTx,
  cancelTx,
  type IntegrityReport,
  type QueuedOp,
  type GovOp,
  type GovTargets,
  type TimelockRole,
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

const ZERO = '0x0000000000000000000000000000000000000000';
/** Operations that can reach funds or approvals: worth telling everyone about the moment they are queued. */
const SENSITIVE = /UPGRADE EVERY POOL|Upgrade the router|Upgrade the factory|Transfer .* ownership/;

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
  const local = readLocalDeployments();
  const factory = DEPLOYED.AMM_FACTORY ?? local?.values.AMM_FACTORY ?? null;
  const router = DEPLOYED.AMM_ROUTER ?? local?.values.AMM_ROUTER ?? null;
  const [tab, setTab] = useState<Tab>('INTEGRITY');
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [ops, setOps] = useState<QueuedOp[] | null>(null);
  const [loadingOps, setLoadingOps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyTx, setBusyTx] = useState<string | null>(null);
  const [roles, setRoles] = useState({ proposer: false, canceller: false });
  const isProposer = roles.proposer;
  const [preset, setPreset] = useState<string | null>(null);
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

  // The queue is read once the timelock is known (so a pending upgrade is flagged on the first screen) and again on its tabs.
  useEffect(() => { if (timelock && (ops === null || tab === 'QUEUE' || tab === 'PROPOSE')) loadOps(); }, [tab, loadOps, timelock]); // eslint-disable-line react-hooks/exhaustive-deps

  // What may the connected wallet do? A proposer queues (and cancels); a guardian only cancels; execution is open unless it was closed.
  useEffect(() => {
    if (!timelock || !walletAddress) { setRoles({ proposer: false, canceller: false }); return; }
    (async () => {
      try {
        const iface = interfaceOf('CircleswapTimelock');
        const has = async (role: string) => Boolean(iface.decodeFunctionResult('hasRole', await reader.call(timelock, iface.encodeFunctionData('hasRole', [role, walletAddress])))[0]);
        const [proposer, canceller] = await Promise.all([has(TIMELOCK_ROLES.proposer), has(TIMELOCK_ROLES.canceller)]);
        if (alive.current) setRoles({ proposer, canceller });
      } catch {
        if (alive.current) setRoles({ proposer: false, canceller: false });
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

  if (!factory) {
    return (
      <Modal title="Governance & integrity" icon={<ShieldCheck size={20} style={{ color: 'var(--accent-plasma)' }} />} onClose={onClose}>
        <Notice tone="info">The AMM is not deployed yet (or not recorded in this browser). Deploy it first, then come back to check and govern it.</Notice>
      </Modal>
    );
  }

  const verdictTone = report?.verdict === 'UNSAFE' ? 'danger' : report?.verdict === 'IMMUTABLE_POOLS' ? 'ok' : 'warn';
  const VerdictIcon = report?.verdict === 'UNSAFE' ? ShieldAlert : report ? ShieldCheck : ShieldQuestion;
  const pendingSensitive = targets && ops ? ops.filter(o => (o.state === 'WAITING' || o.state === 'READY') && SENSITIVE.test(describeCall(o.target, o.data, targets))) : [];
  const ownerLabel = (kind?: string, delay?: number) =>
    kind === 'timelock' ? `Timelock · ${delay ? `${delay / 86_400} days` : '—'}` : kind === 'renounced' ? 'Nobody (permanent)' : kind === 'account' ? 'A single account' : kind === 'contract' ? 'Unknown contract' : '—';
  const poolsFrozen = report?.facts.pairBeaconOwner?.toLowerCase() === ZERO;
  const lifecycle = report
    ? [
        { done: report.verdict !== 'UNSAFE', title: 'Deployed and verified from the chain', detail: report.verdict === 'UNSAFE' ? 'Fix the failures above before anyone uses it.' : 'Code hashes, owners, delays and proxies all match the compiled contracts.' },
        { done: report.facts.pools.total > 0, title: 'First pools created', detail: report.facts.pools.total > 0 ? `${report.facts.pools.total} pool(s) so far.` : 'Create them from the liquidity modal, at the market ratio: the first deposit sets the price.' },
        { done: poolsFrozen, title: 'Pool code frozen (optional, irreversible)', detail: poolsFrozen ? 'Nobody can ever change the code of existing pools.' : 'Do this when the pool code is final. It makes every existing pool untouchable, even by a future factory upgrade. It also means a bug in the pool code could never be fixed in those pools.', action: poolsFrozen ? undefined : { label: 'Queue the freeze', kind: 'freezePools' } },
        { done: report.facts.routerOwnerKind === 'renounced', title: 'Router permanent (optional, irreversible)', detail: report.facts.routerOwnerKind === 'renounced' ? 'The router can never be replaced.' : 'The router holds users\' approvals, so its upgrades are the sensitive ones. Making it permanent removes that power for good; a new router can still be deployed at a new address.', action: report.facts.routerOwnerKind === 'renounced' || !router ? undefined : { label: 'Queue it', kind: 'makeRouterPermanent' } }
      ]
    : [];
  const reportJson = report ? JSON.stringify({ chain: 'Quai Cyprus-1', checkedAt: new Date().toISOString(), factory, router, verdict: report.verdict, summary: report.summary, facts: report.facts, checks: report.checks }, null, 2) : '';

  return (
    <Modal title="Governance & integrity" icon={<ShieldCheck size={20} style={{ color: 'var(--accent-plasma)' }} />} onClose={onClose} locked={busyTx !== null} maxWidth={760}>
      <div role="tablist" style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem' }}>
        {([['INTEGRITY', 'Integrity check'], ['QUEUE', 'Pending changes'], ['PROPOSE', 'Propose a change']] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => { setTab(k); setError(null); }} style={{ ...smallBtn, flex: 1, justifyContent: 'center', borderColor: tab === k ? 'var(--accent-plasma)' : 'var(--panel-border)', background: tab === k ? 'rgba(255, 51, 68, 0.12)' : smallBtn.background }}>
            {label}
          </button>
        ))}
      </div>

      {error && <Notice tone="danger">{error}</Notice>}

      {tab === 'INTEGRITY' && (
        <div>
          <div style={{ ...row, alignItems: 'center', marginBottom: '0.6rem' }}>
            <div style={{ ...muted, fontSize: '0.78rem' }}>Read from the chain just now. Nothing here is taken from this app&apos;s own records.</div>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              {report && <CopyButton text={reportJson} label="Copy report" />}
              <button type="button" style={smallBtn} onClick={check} disabled={checking}>{checking ? <Spinner /> : <RefreshCw size={12} />} Re-check</button>
            </div>
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
              {pendingSensitive.length > 0 && (
                <Notice tone="warn">
                  <strong>{pendingSensitive.length} queued change{pendingSensitive.length === 1 ? '' : 's'} can reach funds or approvals.</strong> {pendingSensitive.length === 1 ? 'It is' : 'They are'} public until {pendingSensitive.length === 1 ? 'it runs' : 'they run'}; if you do not trust the new code, withdraw liquidity and revoke router approvals before then.{' '}
                  <button type="button" style={smallBtn} onClick={() => setTab('QUEUE')}>Review</button>
                </Notice>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.6rem', marginBottom: '0.9rem' }}>
                <div style={box}><div style={{ ...muted, fontSize: '0.7rem' }}>FACTORY OWNER</div><div style={{ fontWeight: 700 }}>{ownerLabel(report.facts.ownerKind, report.facts.timelockDelaySeconds)}</div>{report.facts.owner && report.facts.owner.toLowerCase() !== ZERO && <AddrLink address={report.facts.owner} />}</div>
                {router && <div style={box}><div style={{ ...muted, fontSize: '0.7rem' }}>ROUTER OWNER</div><div style={{ fontWeight: 700 }}>{ownerLabel(report.facts.routerOwnerKind, report.facts.routerTimelockDelaySeconds)}</div>{report.facts.routerOwner && report.facts.routerOwner.toLowerCase() !== ZERO && <AddrLink address={report.facts.routerOwner} />}</div>}
                <div style={box}><div style={{ ...muted, fontSize: '0.7rem' }}>POOL CODE</div><div style={{ fontWeight: 700 }}>{report.facts.pairBeaconOwner && report.facts.pairBeaconOwner.toLowerCase() === '0x0000000000000000000000000000000000000000' ? 'Frozen forever' : 'Upgradable via timelock'}</div>{report.facts.pairImpl && <AddrLink address={report.facts.pairImpl} />}</div>
                <div style={box}><div style={{ ...muted, fontSize: '0.7rem' }}>POOLS EXAMINED</div><div style={{ fontWeight: 700 }}>{report.facts.pools.checked} of {report.facts.pools.total}</div><div style={{ ...muted, fontSize: '0.72rem' }}>{report.facts.pools.frozen} frozen · {report.facts.pools.governed} timelocked · {report.facts.pools.foreign} outside</div></div>
              </div>

              <div style={{ ...box, marginBottom: '0.9rem' }}>
                <div style={{ fontWeight: 800, fontSize: '0.82rem', marginBottom: '0.4rem' }}>Where this stands</div>
                {lifecycle.map(step => (
                  <div key={step.title} style={{ display: 'flex', gap: '0.55rem', alignItems: 'flex-start', marginBottom: '0.45rem' }}>
                    {step.done ? <CheckCircle2 size={16} style={{ color: 'var(--success)', flexShrink: 0, marginTop: 1 }} /> : <Circle size={16} style={{ color: 'var(--text-dim)', flexShrink: 0, marginTop: 1 }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: '0.8rem' }}>{step.title}</div>
                      <div style={{ ...muted, fontSize: '0.74rem' }}>{step.detail}</div>
                    </div>
                    {'action' in step && step.action && <button type="button" style={smallBtn} onClick={() => { setPreset(step.action!.kind); setTab('PROPOSE'); }}>{step.action.label}</button>}
                  </div>
                ))}
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
                const sensitive = SENSITIVE.test(text);
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
                        <button type="button" style={smallBtn} disabled={!roles.canceller || busyTx !== null} title={roles.canceller ? undefined : 'Only a proposer or a guardian can cancel'} onClick={async () => { if (await send('cancel', cancelTx(targets.timelock, o.id))) loadOps(); }}>
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
        <Propose targets={targets} delaySeconds={report?.facts.timelockDelaySeconds ?? 0} walletAddress={walletAddress} onConnect={onConnect} isProposer={isProposer} busy={busyTx !== null} preset={preset} onPresetUsed={() => setPreset(null)} onSend={async (_op, tx, salt, id) => { const ok = await send('schedule', tx); if (ok) { rememberSalt(id, salt); loadOps(); } return ok; }} />
      )}
    </Modal>
  );
}

type Kind = keyof typeof OPS;
const KINDS: { kind: Kind; label: string; arg?: { label: string; placeholder: string }; role?: boolean }[] = [
  { kind: 'setFeeTo', label: 'Set the protocol fee recipient', arg: { label: 'Recipient (blank turns the fee off)', placeholder: '0x00…' } },
  { kind: 'upgradePools', label: 'Upgrade every pool (reaches liquidity)', arg: { label: 'New pool implementation', placeholder: '0x00…' } },
  { kind: 'freezePools', label: 'Freeze pool upgrades forever' },
  { kind: 'newPoolVersion', label: 'New pools follow a new beacon', arg: { label: 'Beacon (owned by the factory)', placeholder: '0x00…' } },
  { kind: 'upgradeRouter', label: 'Upgrade the router', arg: { label: 'New router implementation', placeholder: '0x00…' } },
  { kind: 'upgradeFactory', label: 'Upgrade the factory', arg: { label: 'New factory implementation', placeholder: '0x00…' } },
  { kind: 'makeRouterPermanent', label: 'Make the router permanent' },
  { kind: 'makeFactoryPermanent', label: 'Make the factory permanent' },
  { kind: 'grantRole', label: 'Give someone a role on the timelock', arg: { label: 'Account', placeholder: '0x00…' }, role: true },
  { kind: 'revokeRole', label: 'Remove someone\'s role on the timelock', arg: { label: 'Account', placeholder: '0x00…' }, role: true },
  { kind: 'updateDelay', label: 'Change the timelock delay', arg: { label: 'New delay in days (1 to 30)', placeholder: '3' } }
];
const ROLE_LABEL: Record<TimelockRole, string> = {
  proposer: 'Proposer: can queue changes',
  canceller: 'Guardian: can veto a queued change, nothing else',
  executor: 'Executor: can run a ready change'
};

function Propose({ targets, delaySeconds, walletAddress, onConnect, isProposer, busy, preset, onPresetUsed, onSend }: {
  targets: GovTargets | null;
  delaySeconds: number;
  walletAddress: string | null;
  onConnect: () => void;
  isProposer: boolean;
  busy: boolean;
  /** A kind to start on (from a "where this stands" shortcut). */
  preset?: string | null;
  onPresetUsed?: () => void;
  onSend: (op: GovOp, tx: { to: string; data: string }, salt: string, id: string) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<Kind>((preset as Kind) ?? 'setFeeTo');
  const [arg, setArg] = useState('');
  const [role, setRole] = useState<TimelockRole>('canceller');
  useEffect(() => {
    if (preset && KINDS.some(k => k.kind === preset)) {
      setKind(preset as Kind);
      setArg('');
    }
    if (preset) onPresetUsed?.();
  }, [preset]); // eslint-disable-line react-hooks/exhaustive-deps
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
        : kind === 'grantRole' ? OPS.grantRole(t, role, arg.trim())
        : kind === 'revokeRole' ? OPS.revokeRole(t, role, arg.trim())
        : kind === 'upgradePools' ? OPS.upgradePools(t, arg.trim())
        : kind === 'newPoolVersion' ? OPS.newPoolVersion(t, arg.trim())
        : kind === 'upgradeRouter' ? OPS.upgradeRouter(t, arg.trim())
        : OPS.upgradeFactory(t, arg.trim());
      return { op, error: null };
    } catch (e: any) {
      return { op: null, error: arg ? e?.message ?? String(e) : null };
    }
  }, [targets, kind, arg, role]);

  const prepared = useMemo(() => (built.op && delaySeconds ? scheduleTx(targets!.timelock, built.op, delaySeconds) : null), [built.op, delaySeconds, targets]);
  // A fresh salt per attempt; reset acknowledgement when the operation changes.
  useEffect(() => { setAck(false); setScheduled(null); }, [kind, arg, role]);

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
      {spec.role && (
        <Field label="Role">
          <select style={{ ...input, padding: '0.45rem' }} value={role} onChange={e => setRole(e.target.value as TimelockRole)} aria-label="Role">
            {(Object.keys(ROLE_LABEL) as TimelockRole[]).map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </Field>
      )}
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

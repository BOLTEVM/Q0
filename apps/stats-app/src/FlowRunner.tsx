import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Circle, XCircle, Loader2, FileCode2, RotateCcw } from 'lucide-react';
import { DEPLOYED, quaiRpcCall, formatUnits } from 'quai-service';
import {
  runFlow,
  quoteStep,
  projectCreationGas,
  creationBytes,
  depositedBytes,
  creationGasLimit,
  emptyProgress,
  loadProgress,
  clearProgress,
  sameSettings,
  pendingSteps,
  renderDeployedTs,
  deployedFromProgress,
  type Flow,
  type FlowProgress,
  type StepQuote,
  type StepStatus,
  type DeployStep,
  type RunnerEnv
} from 'quai-service/deploy';
import { saveLocalDeployments, readLocalDeployments } from 'quai-service/bootstrap';
import { getQuaiProvider } from './providerUtils';
import { Notice, Spinner, AddrLink, CopyButton, box, muted, smallBtn } from './ui';

const CHAIN_ID = 9;
const quai = (wei: bigint) => `${formatUnits(wei, 18, 4)} QUAI`;

interface Props {
  flowId: 'QRB' | 'AMM' | 'FARM';
  /** The steps for the current settings, or null while the settings are invalid (then `configError` says why). */
  flow: Flow | null;
  configError: string | null;
  /** Digest of the settings: a saved run is only resumed under the same ones. */
  fingerprint: string;
  /** Addresses the flow needs that it does not create itself (an existing farm or Qrb). */
  initialCtx?: Record<string, string>;
  artworkUri?: string | null;
  walletAddress: string | null;
  onConnect: () => void;
  /** True while a transaction is being signed or confirmed, so the host can keep its modal open. */
  onBusy: (busy: boolean) => void;
}

interface Estimate {
  quote?: StepQuote;
  projectedLimit?: bigint;
  note?: string;
}

const STATUS_TEXT: Record<StepStatus, string> = {
  pending: 'Waiting',
  quoting: 'Simulating…',
  'awaiting-signature': 'Waiting for your approval',
  confirming: 'Confirming on chain…',
  done: 'Done',
  skipped: 'Already done on chain',
  failed: 'Failed'
};

export default function FlowRunner({ flowId, flow, configError, fingerprint, initialCtx, artworkUri, walletAddress, onConnect, onBusy }: Props) {
  const provider = useMemo(() => getQuaiProvider(), []);
  const [saved, setSaved] = useState<FlowProgress | null>(null);
  const [progress, setProgress] = useState<FlowProgress | null>(null);
  const [statuses, setStatuses] = useState<Record<string, { status: StepStatus; txHash?: string; address?: string; error?: string }>>({});
  const [estimates, setEstimates] = useState<Record<string, Estimate> | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ step: DeployStep; quote: StepQuote } | null>(null);
  const confirmResolve = useRef<((ok: boolean) => void) | null>(null);
  const [savedLocal, setSavedLocal] = useState(false);

  const isCyprus1 = Boolean(walletAddress && walletAddress.toLowerCase().startsWith('0x00'));

  // Load whatever an earlier run left behind for this wallet.
  useEffect(() => {
    setSaved(walletAddress && isCyprus1 ? loadProgress(localStorage, flowId, CHAIN_ID, walletAddress) : null);
    setProgress(null);
    setStatuses({});
    setEstimates(null);
    setError(null);
    setSavedLocal(false);
  }, [flowId, walletAddress, isCyprus1]);

  useEffect(() => onBusy(running), [running, onBusy]);

  const sameAsSaved = saved ? sameSettings(saved, fingerprint) : false;
  const mismatch = Boolean(saved && !sameAsSaved && Object.keys(saved.steps).length > 0);

  const env = useCallback(
    (): RunnerEnv => ({
      rpc: (m, p) => quaiRpcCall(m, p as any[]),
      wallet: provider,
      from: walletAddress!,
      chainId: CHAIN_ID,
      store: localStorage
    }),
    [provider, walletAddress]
  );

  const workingProgress = (): FlowProgress => {
    if (saved && sameAsSaved) return saved;
    return emptyProgress(flowId, CHAIN_ID, walletAddress!, initialCtx ?? {}, fingerprint);
  };

  const simulate = async () => {
    if (!flow || !walletAddress) return;
    setSimulating(true);
    setError(null);
    try {
      const e = env();
      const p = workingProgress();
      const ctx = { ...p.ctx };
      const out: Record<string, Estimate> = {};
      let reference: { estimate: bigint; bytes: number; gasPrice: bigint } | null = null;
      for (const step of flow.steps) {
        if (p.steps[step.id]?.done) continue;
        if (step.kind === 'call' && !ctx[step.targetKey!]) {
          out[step.id] = { note: 'Priced once the contract it calls exists.' };
          continue;
        }
        try {
          const q = await quoteStep(e, step, ctx);
          out[step.id] = { quote: q };
          if (step.kind === 'create') {
            reference = { estimate: q.gasEstimate, bytes: creationBytes(step), gasPrice: q.gasPrice };
          }
        } catch (err: any) {
          if (step.kind === 'create' && reference && /has not produced/.test(String(err?.message))) {
            const est = projectCreationGas(reference.estimate, reference.bytes, creationBytes(step));
            out[step.id] = { projectedLimit: creationGasLimit(est, depositedBytes(step), creationBytes(step)), note: 'Projected from the size of the contract; simulated exactly when reached.' };
          } else {
            out[step.id] = { note: String(err?.message ?? err) };
          }
        }
      }
      setEstimates(out);
      setBalance(BigInt(await quaiRpcCall('quai_getBalance', [walletAddress, 'latest'])));
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setSimulating(false);
    }
  };

  const gasPrice = useMemo(() => {
    const q = estimates && Object.values(estimates).find(v => v.quote);
    return q?.quote?.gasPrice ?? null;
  }, [estimates]);

  const budget = useMemo(() => {
    if (!estimates) return null;
    let total = 0n;
    for (const v of Object.values(estimates)) {
      if (v.quote) total += v.quote.maxFee;
      else if (v.projectedLimit && gasPrice) total += v.projectedLimit * gasPrice;
    }
    return total;
  }, [estimates, gasPrice]);

  const start = async () => {
    if (!flow || !walletAddress || !provider) return;
    setRunning(true);
    setError(null);
    const p = workingProgress();
    setProgress(p);
    setSaved(p);
    try {
      await runFlow(env(), flow, p, {
        onStatus: (id, status, info) => {
          setStatuses(s => ({ ...s, [id]: { status, txHash: info?.txHash ?? s[id]?.txHash, address: info?.address ?? s[id]?.address, error: info?.error } }));
          setProgress({ ...p });
        },
        confirm: (step, quote) =>
          new Promise<boolean>(resolve => {
            confirmResolve.current = resolve;
            setConfirm({ step, quote });
          })
      });
      if (flow.steps.every(s => p.steps[s.id]?.done)) {
        const base = { ...DEPLOYED, ...(readLocalDeployments()?.values ?? {}) };
        const dep = deployedFromProgress(base, [p], artworkUri);
        if (dep) {
          saveLocalDeployments(dep);
          setSavedLocal(true);
        }
      }
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setConfirm(null);
      setRunning(false);
      setProgress({ ...p });
      setSaved(loadProgress(localStorage, flowId, CHAIN_ID, walletAddress));
    }
  };

  const answer = (ok: boolean) => {
    confirmResolve.current?.(ok);
    confirmResolve.current = null;
    setConfirm(null);
  };

  const discard = () => {
    if (walletAddress) clearProgress(localStorage, flowId, CHAIN_ID, walletAddress);
    setSaved(null);
    setProgress(null);
    setStatuses({});
  };

  const shown = progress ?? (saved && sameAsSaved ? saved : null);
  const finished = Boolean(flow && shown && flow.steps.every(s => shown.steps[s.id]?.done));
  const pending = shown ? pendingSteps(shown) : [];

  const deployedValues = shown
    ? deployedFromProgress({ ...DEPLOYED, ...(readLocalDeployments()?.values ?? {}) }, [shown], artworkUri)
    : null;
  const deployedTs = useMemo(() => {
    try {
      return deployedValues ? renderDeployedTs(deployedValues) : null;
    } catch {
      return null;
    }
  }, [deployedValues]);

  if (!walletAddress) {
    return (
      <div>
        <Notice tone="info">Connect the wallet that will own the contracts and pay the gas.</Notice>
        <button type="button" className="btn-primary" style={{ width: '100%' }} onClick={onConnect}>Connect wallet</button>
      </div>
    );
  }
  if (!isCyprus1) {
    return <Notice tone="danger">The connected account ({walletAddress.slice(0, 10)}…) is not a Cyprus-1 address (0x00…). Switch the wallet to a Cyprus-1 account: contracts created from another shard cannot be used here.</Notice>;
  }
  if (!provider) return <Notice tone="danger">No Quai wallet was found in this browser.</Notice>;

  return (
    <div>
      {mismatch && (
        <Notice tone="warn">
          A saved run for this wallet was started with <strong>different settings</strong>. It is kept so nothing is lost, but it cannot be combined with these settings.
          <div style={{ marginTop: '0.4rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {Object.entries(saved!.ctx).map(([k, v]) => (
              <span key={k} style={{ fontSize: '0.72rem' }}>{k}: <AddrLink address={v} /></span>
            ))}
          </div>
          <button type="button" style={{ ...smallBtn, marginTop: '0.5rem' }} onClick={discard}><RotateCcw size={12} /> Discard the saved run</button>
        </Notice>
      )}
      {saved && sameAsSaved && Object.keys(saved.steps).length > 0 && !finished && !running && (
        <Notice tone="info">
          An earlier run with these settings was found ({flow?.steps.filter(s => saved.steps[s.id]?.done).length ?? 0} of {flow?.steps.length ?? 0} steps done
          {pending.length ? `; a sent transaction is still unconfirmed, it will be waited on, not sent again` : ''}). Resume continues it; everything already done is re-checked on chain, not trusted.
          <div style={{ marginTop: '0.4rem' }}><button type="button" style={smallBtn} onClick={discard}><RotateCcw size={12} /> Start over instead</button></div>
        </Notice>
      )}
      {configError && <Notice tone="danger">{configError}</Notice>}

      {flow && (
        <div style={{ marginBottom: '0.9rem' }}>
          {flow.steps.map((step, i) => {
            const st = statuses[step.id];
            const sp = shown?.steps[step.id];
            const status: StepStatus = st?.status ?? (sp?.done ? 'done' : 'pending');
            const est = estimates?.[step.id];
            const icon =
              status === 'done' || status === 'skipped' ? <CheckCircle2 size={18} style={{ color: 'var(--success)' }} />
              : status === 'failed' ? <XCircle size={18} style={{ color: 'var(--error)' }} />
              : status === 'pending' ? <Circle size={18} style={{ color: 'var(--text-dim)' }} />
              : <Loader2 size={18} className="loader" style={{ color: 'var(--accent-neon)' }} />;
            return (
              <div key={step.id} style={{ ...box, display: 'flex', gap: '0.6rem', marginBottom: '0.4rem', alignItems: 'flex-start' }}>
                <div style={{ paddingTop: 1 }}>{icon}</div>
                <div style={{ minWidth: 0, flex: 1, fontSize: '0.82rem' }}>
                  <div style={{ fontWeight: 700 }}>{i + 1}. {step.label}</div>
                  <div style={{ ...muted, fontSize: '0.72rem' }}>
                    {STATUS_TEXT[status]}
                    {(st?.txHash ?? sp?.txHash) && <> · tx <AddrLink address={(st?.txHash ?? sp?.txHash)!} tx /></>}
                    {(st?.address ?? sp?.address) && <> · contract <AddrLink address={(st?.address ?? sp?.address)!} /></>}
                  </div>
                  {step.note && status === 'pending' && <div style={{ fontSize: '0.72rem', color: 'var(--warning)' }}>{step.note}</div>}
                  {est?.quote && status === 'pending' && (
                    <div style={{ ...muted, fontSize: '0.72rem' }}>
                      estimate {est.quote.gasEstimate.toString()} gas · limit {est.quote.gasLimit.toString()} · at most {quai(est.quote.maxFee)}
                    </div>
                  )}
                  {est?.projectedLimit && gasPrice && status === 'pending' && (
                    <div style={{ ...muted, fontSize: '0.72rem' }}>about {est.projectedLimit.toString()} gas limit · at most ~{quai(est.projectedLimit * gasPrice)} (projected)</div>
                  )}
                  {est?.note && !est.quote && status === 'pending' && <div style={{ ...muted, fontSize: '0.72rem' }}>{est.note}</div>}
                  {st?.error && <div style={{ fontSize: '0.75rem', color: 'var(--error)', marginTop: 2 }}>{st.error}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {budget !== null && !finished && (
        <div style={{ ...box, marginBottom: '0.9rem', fontSize: '0.82rem' }}>
          Worst-case gas for the steps left: <strong>{quai(budget)}</strong>
          {balance !== null && <> · wallet holds <strong>{quai(balance)}</strong></>}
          {balance !== null && balance < budget && <div style={{ color: 'var(--warning)', marginTop: 2 }}>The wallet holds less than the worst case. That figure is every step&apos;s whole gas limit added up; what a step does not use is refunded, and what a creation really uses has varied from about 0.4× to 2.5× the simulator&apos;s estimate on Quai, so the limits are set wide on purpose (a transaction that runs out of gas or reverts uses its whole limit). Each step checks its own funds before it asks you to sign, and a stopped run resumes where it stopped, so you can top up part-way.</div>}
        </div>
      )}

      {confirm && (
        <div style={{ ...box, borderColor: 'var(--accent-plasma)', marginBottom: '0.9rem' }}>
          <div style={{ fontWeight: 800, marginBottom: '0.3rem' }}>Approve: {confirm.step.label}</div>
          <div style={{ fontSize: '0.78rem', lineHeight: 1.5 }}>
            Gas limit {confirm.quote.gasLimit.toString()} · at most <strong>{quai(confirm.quote.maxFee)}</strong>
            {confirm.quote.predictedAddress && <><br />Expected contract address (the receipt decides): <span style={{ fontFamily: 'monospace' }}>{confirm.quote.predictedAddress}</span></>}
            {confirm.step.note && <><br /><span style={{ color: 'var(--warning)' }}>{confirm.step.note}</span></>}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
            <button type="button" className="btn-primary" style={{ flex: 1, minHeight: 40 }} onClick={() => answer(true)}>Send to my wallet to sign</button>
            <button type="button" style={smallBtn} onClick={() => answer(false)}>Stop</button>
          </div>
        </div>
      )}

      {error && <Notice tone="danger">{error}</Notice>}

      {!finished && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" style={{ ...smallBtn, padding: '0.6rem 1rem' }} onClick={simulate} disabled={!flow || simulating || running}>
            {simulating ? <Spinner /> : null} Check cost (simulate)
          </button>
          <button type="button" className="btn-primary" style={{ flex: 1, minHeight: 44 }} onClick={start} disabled={!flow || running || simulating || mismatch}>
            {running ? <><Spinner /> Working…</> : saved && sameAsSaved && Object.keys(saved.steps).length ? 'Resume deployment' : 'Start deployment'}
          </button>
        </div>
      )}

      {finished && deployedValues && (
        <div>
          <Notice tone="ok"><strong>Deployed and verified on chain.</strong> Every address below was read from its transaction receipt and checked (code, owner and settings) before the next step.</Notice>
          <div className="table-wrapper" style={{ marginBottom: '0.75rem' }}>
            <table>
              <tbody>
                {Object.entries(shown!.ctx).map(([k, v]) => (
                  <tr key={k}>
                    <td style={{ fontWeight: 700 }}>{k}</td>
                    <td><AddrLink address={v} /></td>
                    <td style={{ textAlign: 'right' }}><CopyButton text={v} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary"
              style={{ flex: 1, minHeight: 42 }}
              disabled={savedLocal}
              onClick={() => {
                saveLocalDeployments(deployedValues);
                setSavedLocal(true);
              }}
            >
              {savedLocal ? 'Saved: reload to use it' : 'Use these contracts in this browser'}
            </button>
            {savedLocal && <button type="button" style={smallBtn} onClick={() => window.location.reload()}>Reload now</button>}
            {deployedTs && <CopyButton text={deployedTs} label="Copy deployed.ts" />}
          </div>
          <div style={{ ...muted, fontSize: '0.72rem', marginTop: '0.5rem', display: 'flex', gap: '0.35rem' }}>
            <FileCode2 size={13} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              To make this permanent for everyone, replace <code>packages/quai-service/src/registries/deployed.ts</code> with the copied text and rebuild. Until then the
              addresses live only in this browser, and are re-checked on chain every time the app starts.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}


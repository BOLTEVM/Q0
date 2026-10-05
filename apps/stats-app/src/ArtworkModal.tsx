import { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Upload, ExternalLink, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Modal, Field, Notice, Spinner, CopyButton, input, muted, smallBtn, box } from './ui';
import {
  sha256Hex,
  normalizeArweaveUri,
  verifyUriServes,
  loadArtwork,
  saveArtwork,
  clearArtwork,
  formatBytes,
  gatewayUrl,
  type SavedArtwork,
  type VerifyOutcome
} from './artwork';

interface Props {
  onClose: () => void;
  /** Called with the saved artwork (or null if it was cleared) so the deploy hub can refresh. */
  onChanged: (a: SavedArtwork | null) => void;
}

interface LocalFile {
  name: string;
  type: string;
  bytes: number;
  sha256: string;
  previewUrl: string | null;
}

export default function ArtworkModal({ onClose, onChanged }: Props) {
  const [saved, setSaved] = useState<SavedArtwork | null>(() => loadArtwork());
  const [file, setFile] = useState<LocalFile | null>(null);
  const [hashing, setHashing] = useState(false);
  const [uriText, setUriText] = useState(saved?.uri ?? '');
  const [verifying, setVerifying] = useState(false);
  const [outcome, setOutcome] = useState<VerifyOutcome | null>(null);
  const [override, setOverride] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const take = async (blob: Blob, name: string) => {
    setHashing(true);
    setError(null);
    setOutcome(null);
    try {
      const buf = await blob.arrayBuffer();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const previewUrl = blob.type.startsWith('image/') || blob.type.startsWith('video/') ? URL.createObjectURL(blob) : null;
      urlRef.current = previewUrl;
      setFile({ name, type: blob.type || 'application/octet-stream', bytes: buf.byteLength, sha256: await sha256Hex(buf), previewUrl });
    } catch (e: any) {
      setError(e?.message ?? 'Could not read that file.');
    } finally {
      setHashing(false);
    }
  };

  const useBundled = async () => {
    try {
      const res = await fetch('/QgoGIF.gif');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await take(await res.blob(), 'QgoGIF.gif');
    } catch (e: any) {
      setError(`Could not load the bundled artwork: ${e?.message ?? e}`);
    }
  };

  const normalized = normalizeArweaveUri(uriText);
  const expectedSha = file?.sha256 ?? saved?.sha256 ?? null;

  const verify = async () => {
    if (!normalized || !expectedSha) return;
    setVerifying(true);
    setOutcome(null);
    setOutcome(await verifyUriServes(normalized, expectedSha));
    setVerifying(false);
  };

  const canSave = Boolean(file && normalized && (outcome?.status === 'match' || (outcome?.status === 'unreachable' && override)));

  const save = () => {
    if (!file || !normalized) return;
    const a: SavedArtwork = { uri: normalized, sha256: file.sha256, bytes: file.bytes, name: file.name, verifiedAt: outcome?.status === 'match' ? Date.now() : null };
    saveArtwork(a);
    setSaved(a);
    onChanged(a);
  };

  const clear = () => {
    clearArtwork();
    setSaved(null);
    setFile(null);
    setOutcome(null);
    setUriText('');
    onChanged(null);
  };

  return (
    <Modal title="Artwork" icon={<ImageIcon size={20} style={{ color: 'var(--accent-plasma)' }} />} onClose={onClose} maxWidth={620}>
      <Notice tone="warn">
        <strong>The artwork link is permanent.</strong> Qrb and the NFT store an Arweave address in their constructors and have no way to change it afterwards. This page checks that
        the address serves exactly your file before you can deploy with it.
      </Notice>

      {saved && (
        <div style={{ ...box, marginBottom: '1rem', borderColor: saved.verifiedAt ? 'var(--success)' : 'var(--warning)' }}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontWeight: 700 }}>
            {saved.verifiedAt ? <CheckCircle2 size={16} style={{ color: 'var(--success)' }} /> : <AlertTriangle size={16} style={{ color: 'var(--warning)' }} />}
            Deployment artwork: {saved.name}
          </div>
          <div style={{ fontSize: '0.78rem', wordBreak: 'break-all', margin: '0.3rem 0' }}>{saved.uri}</div>
          <div style={{ ...muted, fontSize: '0.72rem' }}>
            {formatBytes(saved.bytes)} · sha256 {saved.sha256.slice(0, 16)}…{' '}
            {saved.verifiedAt ? `· verified ${new Date(saved.verifiedAt).toLocaleString()}` : '· saved WITHOUT verification (gateway unreachable)'}
          </div>
          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
            <a style={{ ...smallBtn, textDecoration: 'none' }} href={gatewayUrl(saved.uri)} target="_blank" rel="noreferrer">Open <ExternalLink size={11} /></a>
            <CopyButton text={saved.uri} label="Copy URI" />
            <button type="button" style={smallBtn} onClick={clear}>Clear</button>
          </div>
        </div>
      )}

      <div style={{ fontWeight: 800, margin: '0.25rem 0 0.5rem', fontFamily: 'var(--font-display)' }}>1. Choose the file</div>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <label style={{ ...smallBtn, cursor: 'pointer' }}>
          <Upload size={12} /> Choose a file
          <input type="file" accept="image/*,video/*" style={{ display: 'none' }} onChange={e => e.target.files?.[0] && take(e.target.files[0], e.target.files[0].name)} />
        </label>
        <button type="button" style={smallBtn} onClick={useBundled}>Use the bundled QgoGIF.gif</button>
        {hashing && <span style={muted}><Spinner /> Hashing…</span>}
      </div>
      {file && (
        <div style={{ ...box, display: 'flex', gap: '0.8rem', marginBottom: '1rem' }}>
          {file.previewUrl && (file.type.startsWith('video/') ? (
            <video src={file.previewUrl} style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 8 }} muted loop autoPlay />
          ) : (
            <img src={file.previewUrl} alt="Artwork preview" style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 8 }} />
          ))}
          <div style={{ minWidth: 0, fontSize: '0.8rem' }}>
            <div style={{ fontWeight: 700 }}>{file.name}</div>
            <div style={muted}>{file.type} · {formatBytes(file.bytes)}</div>
            <div style={{ ...muted, fontFamily: 'monospace', fontSize: '0.68rem', wordBreak: 'break-all' }}>sha256 {file.sha256}</div>
          </div>
        </div>
      )}

      <div style={{ fontWeight: 800, margin: '0.25rem 0 0.5rem', fontFamily: 'var(--font-display)' }}>2. Upload it to Arweave</div>
      <div style={{ fontSize: '0.8rem', lineHeight: 1.5, marginBottom: '0.75rem' }}>
        This app does not upload for you: that needs your own Arweave or Turbo credits. Upload the <em>exact same file</em> with the{' '}
        <a href="https://turbo.ardrive.io" target="_blank" rel="noreferrer" className="link-hash">Turbo web uploader</a> (check its current pricing and free tier), or run{' '}
        <code>pnpm --filter contracts upload:artwork</code>, then paste the transaction id below.
      </div>

      <Field label="3. Arweave URI or transaction id" hint="ar://<43 characters>, https://arweave.net/<43 characters>, or the bare id.">
        <input style={input} value={uriText} onChange={e => { setUriText(e.target.value); setOutcome(null); setOverride(false); }} placeholder="ar://…" spellCheck={false} aria-label="Arweave URI" />
      </Field>
      {uriText && !normalized && <Notice tone="danger">That is not an Arweave address. It must contain a 43-character id (letters, digits, - and _).</Notice>}

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.75rem' }}>
        <button type="button" className="btn-primary" style={{ fontSize: '0.85rem', padding: '0.4rem 1rem', minHeight: 38 }} onClick={verify} disabled={!normalized || !expectedSha || verifying}>
          {verifying ? <Spinner /> : null} Check that it serves my file
        </button>
        {!expectedSha && <span style={{ ...muted, fontSize: '0.75rem' }}>Choose the file first.</span>}
      </div>

      {outcome?.status === 'match' && <Notice tone="ok"><strong>Verified.</strong> The address serves {formatBytes(outcome.bytes)} with exactly the same SHA-256 as your file.</Notice>}
      {outcome?.status === 'mismatch' && (
        <Notice tone="danger">
          <strong>Different file.</strong> That address serves {formatBytes(outcome.bytes)} with SHA-256 {outcome.sha256.slice(0, 16)}…, not yours. It cannot be used. Re-upload the exact file, or check the id.
        </Notice>
      )}
      {outcome?.status === 'unreachable' && (
        <Notice tone="warn">
          <strong>Could not check.</strong> {outcome.detail}
          <label style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-start', marginTop: '0.4rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={override} onChange={e => setOverride(e.target.checked)} style={{ marginTop: 3 }} />
            <span>I have checked it myself and accept that an address serving the wrong file is permanent once deployed.</span>
          </label>
        </Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}

      <button type="button" className="btn-primary" style={{ width: '100%' }} disabled={!canSave} onClick={save}>
        Use this artwork for deployment
      </button>
    </Modal>
  );
}

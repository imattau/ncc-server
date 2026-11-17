import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Event } from 'nostr-tools';

import { mimeFor, sha256Hex, uploadBlob, verifyBlob } from './lib/blossom';
import {
  nsiteAddress,
  publishManifest,
  signManifest,
  validateFiles,
  validateSiteId,
  type RelayReport,
  type SiteFile,
} from './lib/manifest';
import { detectSigner, errorMessage, type Nip07Signer } from './lib/nip07';

const DEFAULT_RELAYS = ['wss://relay.primal.net', 'wss://relay.ditto.pub', 'wss://nos.lol'];
const DEFAULT_SERVERS = [
  'https://blossom.ditto.pub',
  'https://nostr.download',
  'https://blossom.primal.net',
];
const STORAGE_KEY = 'ncc-search-nsite-publisher:v1';

type Tone = 'info' | 'ok' | 'bad';
interface LogEntry {
  text: string;
  tone: Tone;
}

type Phase = 'idle' | 'hashing' | 'uploading' | 'publishing' | 'verifying';

function splitList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean))];
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function toneClass(tone: Tone): string {
  return tone === 'ok' ? 'log-ok' : tone === 'bad' ? 'log-bad' : 'log-info';
}

export function App() {
  const [files, setFiles] = useState<SiteFile[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [siteId, setSiteId] = useState('nccsearch');
  const [title, setTitle] = useState('nccsearch');
  const [description, setDescription] = useState(
    'Search NCC services, nsites, articles, media and profiles from relays — crawled and indexed in your browser.',
  );
  const [source, setSource] = useState('https://github.com/imattau/ncc-server');
  const [relayText, setRelayText] = useState(DEFAULT_RELAYS.join('\n'));
  const [serverText, setServerText] = useState(DEFAULT_SERVERS.join('\n'));

  const [pubkey, setPubkey] = useState<string | null>(null);
  const [manifest, setManifest] = useState<Event | null>(null);
  const [reports, setReports] = useState<RelayReport[]>([]);
  const [verification, setVerification] = useState<{ checked: number; missing: string[] } | null>(null);
  const [copied, setCopied] = useState(false);

  const signerRef = useRef<Nip07Signer | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const logEnd = useRef<HTMLDivElement | null>(null);

  const busy = phase !== 'idle';
  const address = pubkey ? nsiteAddress(pubkey, siteId) : null;
  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const siteIdError = validateSiteId(siteId);
  const fileProblems = useMemo(() => validateFiles(files), [files]);
  const manifestServers = useMemo(
    () => (manifest ? manifest.tags.filter((tag) => tag[0] === 'server').map((tag) => tag[1]) : []),
    [manifest],
  );

  // The built folder is the only input that cannot be remembered (a File is
  // not serialisable), but everything around it can be, so republishing
  // after a rebuild is one folder pick away.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Record<string, unknown> | null;
      if (!saved) return;
      if (typeof saved.siteId === 'string') setSiteId(saved.siteId);
      if (typeof saved.title === 'string') setTitle(saved.title);
      if (typeof saved.description === 'string') setDescription(saved.description);
      if (typeof saved.source === 'string') setSource(saved.source);
      if (typeof saved.relayText === 'string') setRelayText(saved.relayText);
      if (typeof saved.serverText === 'string') setServerText(saved.serverText);
    } catch {
      // A corrupt/absent saved form is not worth failing over.
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ siteId, title, description, source, relayText, serverText }),
      );
    } catch {
      // private contexts may refuse storage
    }
  }, [siteId, title, description, source, relayText, serverText]);

  useEffect(() => {
    if (folderInput.current) folderInput.current.setAttribute('webkitdirectory', '');
  }, []);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [log]);

  const append = useCallback((text: string, tone: Tone = 'info') => {
    setLog((entries) => [...entries.slice(-300), { text, tone }]);
  }, []);

  const chooseFolder = useCallback(async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setError(null);
    setLog([]);
    setManifest(null);
    setReports([]);
    setVerification(null);
    setFiles([]);

    const picked = [...list]
      .filter((file) => {
        const parts = (file.webkitRelativePath || file.name).split('/');
        return !parts.some((part) => part === '__MACOSX' || part.startsWith('.'));
      })
      .map((file) => {
        const parts = (file.webkitRelativePath || file.name).split('/');
        return { path: `/${parts.slice(1).join('/')}`, file };
      })
      .filter((entry) => entry.path !== '/' && !entry.path.endsWith('/'));

    if (picked.length === 0) {
      setError('That folder is empty. Choose the build output, e.g. ncc-search/ui/dist-nsite.');
      return;
    }

    setPhase('hashing');
    setProgress({ done: 0, total: picked.length, label: 'Hashing files' });
    let done = 0;
    const hashed = await mapLimit(picked, 4, async (entry) => {
      const hash = await sha256Hex(await entry.file.arrayBuffer());
      done += 1;
      setProgress({ done, total: picked.length, label: 'Hashing files' });
      return {
        path: entry.path,
        hash,
        size: entry.file.size,
        file: entry.file,
      } satisfies SiteFile;
    });
    setPhase('idle');
    setProgress(null);
    setFiles(hashed.sort((a, b) => a.path.localeCompare(b.path)));
    append(`Read ${hashed.length} files (${(hashed.reduce((sum, file) => sum + file.size, 0) / 1024).toFixed(0)} KB).`, 'ok');
  }, [append]);

  const connect = useCallback(async () => {
    setError(null);
    const signer = detectSigner();
    signerRef.current = signer;
    if (!signer) {
      setError('No NIP-07 signer found. Open this page in Nostr Navigator (or install a signing extension) and try again.');
      return;
    }
    try {
      setPubkey(await signer.getPublicKey());
    } catch (connectError) {
      setError(errorMessage(connectError));
    }
  }, []);

  const publish = useCallback(async () => {
    setError(null);
    setVerification(null);
    setManifest(null);
    setReports([]);

    const problems = [...fileProblems];
    if (siteIdError) problems.push(siteIdError);
    if (!pubkey || !signerRef.current) problems.push('Connect a NIP-07 signer first.');
    const servers = splitList(serverText).filter((value) => /^https?:\/\//i.test(value));
    const relays = splitList(relayText).filter((value) => /^wss?:\/\//i.test(value));
    if (servers.length === 0) problems.push('Enter at least one Blossom server (https://…).');
    if (relays.length === 0) problems.push('Enter at least one relay (wss://…).');
    if (problems.length > 0) {
      setError(problems.join(' '));
      return;
    }

    const signer = signerRef.current!;
    setLog([]);

    try {
      setPhase('uploading');
      const served = new Set<string>();
      let uploaded = 0;
      for (const file of files) {
        let stored = false;
        for (const server of servers) {
          const outcome = await uploadBlob({
            server,
            hash: file.hash,
            file: file.file,
            path: file.path,
            signer,
          });
          append(`${file.path} → ${outcome.server}: ${outcome.message}`, outcome.ok ? 'ok' : 'bad');
          if (outcome.ok) {
            stored = true;
            served.add(outcome.server);
          }
        }
        if (!stored) {
          throw new Error(`No Blossom server accepted ${file.path}. Nothing was published.`);
        }
        uploaded += 1;
        setProgress({ done: uploaded, total: files.length, label: 'Uploading files' });
      }

      setPhase('publishing');
      setProgress(null);
      append('Signing the manifest…');
      const event = await signManifest({
        siteId,
        title,
        description,
        source,
        files,
        servers: [...served],
        signer,
      });
      setManifest(event);
      append(`Manifest kind ${event.kind}, ${files.length} paths, ${served.size} server(s).`, 'ok');

      const relayReports = await publishManifest(relays, event);
      setReports(relayReports);
      for (const report of relayReports) {
        append(`${report.relay}: ${report.ok ? 'accepted' : 'rejected'} ${report.message}`.trim(), report.ok ? 'ok' : 'bad');
      }
      if (!relayReports.some((report) => report.ok)) {
        throw new Error('No relay accepted the manifest. The files are uploaded, so you can retry publishing.');
      }
      append('Published. Open the address below, or verify the uploaded files first.', 'ok');
    } catch (publishError) {
      setError(errorMessage(publishError));
    } finally {
      setPhase('idle');
      setProgress(null);
    }
  }, [append, description, fileProblems, files, pubkey, relayText, serverText, siteId, siteIdError, source, title]);

  const verify = useCallback(async () => {
    if (!manifest || files.length === 0) return;
    setError(null);
    setVerification(null);
    setPhase('verifying');
    setProgress({ done: 0, total: files.length, label: 'Verifying uploaded files' });
    const servers = manifestServers;
    const missing: string[] = [];
    let checked = 0;
    for (const file of files) {
      let found = false;
      for (const server of servers) {
        if (await verifyBlob(server, file.hash)) {
          found = true;
          break;
        }
      }
      if (!found) missing.push(file.path);
      checked += 1;
      setProgress({ done: checked, total: files.length, label: 'Verifying uploaded files' });
    }
    setVerification({ checked, missing });
    append(
      missing.length === 0
        ? `All ${checked} files verified against the manifest hashes.`
        : `${missing.length} of ${checked} files could not be verified: ${missing.join(', ')}`,
      missing.length === 0 ? 'ok' : 'bad',
    );
    setPhase('idle');
    setProgress(null);
  }, [append, files, manifest, manifestServers]);

  const copyAddress = useCallback(async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('The clipboard was not available; select the address and copy it manually.');
    }
  }, [address]);

  return (
    <main className="page">
      <header className="masthead">
        <h1>
          Publish an <span className="muted">nsite</span>
        </h1>
        <p>
          Picks the built <code>dist-nsite</code> folder, uploads every file to Blossom, signs a NIP-5A
          manifest with your NIP-07 signer, and publishes it. No key ever reaches this page.
        </p>
      </header>

      <section className="card">
        <h2>
          <span className="step">1</span> Build folder
        </h2>
        <div className="row">
          <input
            ref={folderInput}
            type="file"
            multiple
            className="hidden-input"
            id="folder"
            onChange={(event) => void chooseFolder(event.target.files)}
          />
          <label className="button" htmlFor="folder">
            {files.length ? 'Choose another folder' : 'Choose build folder'}
          </label>
          {files.length > 0 && (
            <span className="muted small">
              {files.length} files · {totalBytes < 100 * 1024 ? (totalBytes / 1024).toFixed(1) : Math.round(totalBytes / 1024)} KB
            </span>
          )}
        </div>
        <p className="hint">
          Built with <code>npm run build:nsite</code> in <code>ncc-search/ui</code>. Choose{' '}
          <code>dist-nsite</code> itself, not its parent.
        </p>

        {files.length > 0 && (
          <div className="file-list">
            {files.map((file) => (
              <div className="file-row" key={file.path}>
                <code>{file.path}</code>
                <span className="muted">{mimeFor(file.path)}</span>
                <span className="muted">{(file.size / 1024).toFixed(1)} KB</span>
                <code className="hash">{file.hash.slice(0, 12)}…</code>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>
          <span className="step">2</span> Site
        </h2>
        <div className="grid">
          <label>
            Site id
            <input value={siteId} onChange={(event) => setSiteId(event.target.value)} spellCheck={false} />
            {siteIdError ? <span className="bad small">{siteIdError}</span> : <span className="muted small">nsite://&lt;you&gt;/{siteId}</span>}
          </label>
          <label>
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="wide">
            Description
            <input value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <label className="wide">
            Source
            <input value={source} onChange={(event) => setSource(event.target.value)} spellCheck={false} />
          </label>
          <label className="wide">
            Blossom servers (one per line)
            <textarea rows={3} value={serverText} onChange={(event) => setServerText(event.target.value)} spellCheck={false} />
            <span className="muted small">
              Every file is uploaded to every server, so readers have more than one place to fetch it.
            </span>
          </label>
          <label className="wide">
            Relays (one per line)
            <textarea rows={3} value={relayText} onChange={(event) => setRelayText(event.target.value)} spellCheck={false} />
          </label>
        </div>
      </section>

      <section className="card">
        <h2>
          <span className="step">3</span> Signer and publish
        </h2>
        <div className="row">
          <button type="button" className="button secondary" onClick={() => void connect()} disabled={busy}>
            {pubkey ? 'Reconnect signer' : 'Connect signer'}
          </button>
          {pubkey ? (
            <span className="ok small">Signer connected · {pubkey.slice(0, 12)}…</span>
          ) : (
            <span className="muted small">NIP-07 signer required</span>
          )}
        </div>

        <div className="row">
          <button
            type="button"
            className="button"
            onClick={() => void publish()}
            disabled={busy || files.length === 0 || !pubkey || Boolean(siteIdError)}
          >
            {phase === 'uploading' ? 'Uploading…' : phase === 'publishing' ? 'Publishing…' : 'Upload and publish'}
          </button>
          {manifest && (
            <button type="button" className="button secondary" onClick={() => void verify()} disabled={busy}>
              {phase === 'verifying' ? 'Verifying…' : 'Verify uploaded files'}
            </button>
          )}
        </div>

        {fileProblems.length > 0 && files.length > 0 && (
          <ul className="problems">
            {fileProblems.map((problem) => (
              <li key={problem} className="bad">{problem}</li>
            ))}
          </ul>
        )}

        {progress && (
          <p className="progress small" role="status">
            {progress.label}: {progress.done}/{progress.total}
            <progress value={progress.done} max={progress.total} />
          </p>
        )}

        {error && <p className="bad" role="alert">{error}</p>}

        {log.length > 0 && (
          <div className="log" aria-label="Publish log">
            {log.map((entry, index) => (
              <div key={index} className={toneClass(entry.tone)}>
                {entry.text}
              </div>
            ))}
            <div ref={logEnd} />
          </div>
        )}
      </section>

      {address && manifest && (
        <section className="card">
          <h2>Result</h2>
          <div className="row wrap">
            <code className="address">{address}</code>
            <button type="button" className="button secondary" onClick={() => void copyAddress()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="hint">
            Open it in Nostr Navigator. The site crawls relays while the tab is open and keeps what it
            indexed for next time.
          </p>
          <dl className="facts">
            <div>
              <dt>Manifest</dt>
              <dd>
                <code>{manifest.id.slice(0, 20)}…</code>
              </dd>
            </div>
            <div>
              <dt>Paths</dt>
              <dd>{manifest.tags.filter((tag) => tag[0] === 'path').length}</dd>
            </div>
            <div>
              <dt>Servers</dt>
              <dd>{manifestServers.length}</dd>
            </div>
          </dl>
          {reports.length > 0 && (
            <ul className="reports">
              {reports.map((report) => (
                <li key={report.relay} className={report.ok ? 'ok' : 'bad'}>
                  <code>{report.relay}</code> {report.ok ? 'accepted' : 'rejected'} {report.message}
                </li>
              ))}
            </ul>
          )}
          {verification && (
            <p className={verification.missing.length === 0 ? 'ok' : 'bad'} role="status">
              {verification.missing.length === 0
                ? `All ${verification.checked} files match their manifest hashes on at least one server.`
                : `${verification.missing.length} of ${verification.checked} files were not found or did not match: ${verification.missing.join(', ')}`}
            </p>
          )}
        </section>
      )}
    </main>
  );
}

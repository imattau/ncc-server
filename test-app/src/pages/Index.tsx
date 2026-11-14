import { useEffect, useState, type FormEvent } from 'react';
import { useSeoMeta } from '@unhead/react';
import type { NostrEvent } from '@nostrify/nostrify';
import { nip19, SimplePool, verifyEvent } from 'nostr-tools';
import { Activity, ArrowUpRight, Check, Copy, Globe2, Radio, Search, Server, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type HostState = 'checking' | 'online' | 'error';

interface LocatorEndpoint {
  url?: string;
  uri?: string;
  protocol?: string;
  family?: string;
  priority?: number;
}

interface LocatorPayload {
  ttl: number;
  updated_at: number;
  endpoints: LocatorEndpoint[];
}

interface LocatorResult {
  event: NostrEvent;
  payload: LocatorPayload;
  expiresAt: number;
}

const relayList = ['wss://relay.primal.net/', 'wss://nos.lol/'];
const candidateTags = ['web-locator', 'web', 'addr'];

function parseLocator(event: NostrEvent, author: string): LocatorResult | null {
  if (event.kind !== 30058 || event.pubkey !== author || !verifyEvent(event)) return null;

  const dTag = event.tags.find(([name]) => name === 'd')?.[1];
  if (!dTag || !candidateTags.includes(dTag)) return null;

  let value: unknown;
  try {
    value = JSON.parse(event.content);
  } catch {
    return null;
  }

  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<LocatorPayload>;
  if (
    !Array.isArray(candidate.endpoints) ||
    !Number.isFinite(Number(candidate.ttl)) ||
    !Number.isFinite(Number(candidate.updated_at))
  ) return null;

  const expirationTag = Number(event.tags.find(([name]) => name === 'expiration')?.[1]);
  const expiresAt = Math.min(
    Number(candidate.updated_at) + Number(candidate.ttl),
    expirationTag > 0 ? expirationTag : Number.POSITIVE_INFINITY,
  );
  if (expiresAt <= Math.floor(Date.now() / 1000)) return null;

  return {
    event,
    expiresAt,
    payload: {
      ttl: Number(candidate.ttl),
      updated_at: Number(candidate.updated_at),
      endpoints: candidate.endpoints as LocatorEndpoint[],
    },
  };
}

function safeEndpoint(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function isPrivateNetworkHost(host: string): boolean {
  return host === 'localhost' || host === '::1' ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host);
}

const Index = () => {
  const [hostState, setHostState] = useState<HostState>('checking');
  const [hostLatency, setHostLatency] = useState<number | null>(null);
  const [npub, setNpub] = useState(import.meta.env.VITE_NCC_TEST_NPUB ?? '');
  const [lookupState, setLookupState] = useState<'idle' | 'loading' | 'found' | 'empty' | 'error'>('idle');
  const [locator, setLocator] = useState<LocatorResult | null>(null);
  const [lookupDetails, setLookupDetails] = useState('');
  const [lookupError, setLookupError] = useState('');
  const [copied, setCopied] = useState(false);

  useSeoMeta({
    title: 'NCC Server Test | Live host & locator check',
    description: 'Check that this NCC-Server page is reachable and verify its public Nostr locator.',
  });

  useEffect(() => {
    const controller = new AbortController();
    const startedAt = performance.now();

    fetch(window.location.href, {
      method: 'HEAD',
      cache: 'no-store',
      signal: controller.signal,
    }).then((response) => {
      setHostLatency(Math.round(performance.now() - startedAt));
      setHostState(response.ok ? 'online' : 'error');
    }).catch(() => {
      setHostState('error');
    });

    return () => controller.abort();
  }, []);

  const handleLookup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLocator(null);
    setLookupDetails('');
    setLookupError('');

    let author: string;
    try {
      const trimmedNpub = npub.trim();
      if (!/^npub1[0-9a-z]+$/i.test(trimmedNpub)) {
        throw new Error('Enter an npub that identifies the locator author.');
      }
      author = nip19.decode(trimmedNpub as `npub1${string}`).data;
    } catch (error) {
      setLookupState('error');
      setLookupError(error instanceof Error ? error.message : 'That npub could not be decoded.');
      return;
    }

    setLookupState('loading');
    const pool = new SimplePool();
    try {
      const filters = [{ kinds: [30058], authors: [author], '#d': candidateTags, limit: 20 }];
      const relayResults = await Promise.allSettled(
        relayList.map((relay) => pool.querySync([relay], filters[0], { maxWait: 10000 })),
      );
      const successfulQueries = relayResults.filter((result) => result.status === 'fulfilled');
      if (successfulQueries.length === 0) {
        throw new Error('All configured relays failed to answer the locator query.');
      }
      const events = successfulQueries.flatMap((result) => result.value);
      const matches = events
        .map((candidate) => parseLocator(candidate, author))
        .filter((candidate): candidate is LocatorResult => candidate !== null)
        .sort((first, second) => second.event.created_at - first.event.created_at);
      setLookupDetails(`${events.length} event(s) received from ${successfulQueries.length} relay(s); ${matches.length} fresh valid locator(s).`);

      if (matches.length === 0) {
        setLookupState('empty');
        return;
      }

      setLocator(matches[0]);
      setLookupState('found');
    } catch (error) {
      setLookupState('error');
      setLookupError(error instanceof Error ? error.message : 'Relay lookup failed.');
    } finally {
      pool.close(relayList);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main className="min-h-screen overflow-hidden bg-[#090e17] text-slate-100 selection:bg-cyan-300/30">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_18%_0%,rgba(26,117,128,0.23),transparent_42%),radial-gradient(ellipse_at_100%_44%,rgba(83,74,143,0.16),transparent_37%)]" />
      <div className="relative mx-auto max-w-6xl px-5 py-7 sm:px-8 sm:py-10">
        <header className="flex items-center justify-between border-b border-white/10 pb-6">
          <a href="/" className="flex items-center gap-3 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">
            <div className="grid size-10 place-items-center rounded-xl border border-cyan-200/20 bg-cyan-300/10 text-cyan-200">
              <Globe2 size={20} aria-hidden="true" />
            </div>
            <span className="text-sm font-semibold tracking-wide text-white">NCC<span className="text-cyan-300">/</span>SERVER</span>
          </a>
          <div className="flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/5 px-3 py-1.5 text-xs text-emerald-200">
            <span className={`size-1.5 rounded-full ${hostState === 'online' ? 'bg-emerald-300' : hostState === 'error' ? 'bg-rose-400' : 'animate-pulse bg-amber-300'}`} />
            {hostState === 'online' ? 'HOST RESPONDING' : hostState === 'error' ? 'HOST CHECK FAILED' : 'CHECKING HOST'}
          </div>
        </header>

        <section className="grid gap-10 pb-12 pt-12 md:grid-cols-[1.15fr_0.85fr] md:items-end md:pb-16 md:pt-16">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-cyan-200/15 bg-cyan-200/[0.06] px-3 py-1.5 text-xs font-medium tracking-wide text-cyan-100">
              <Activity size={14} aria-hidden="true" /> HOST-SIDE TEST PAGE
            </div>
            <h1 className="max-w-2xl text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-5xl md:text-6xl">
              Your host is on the <span className="text-cyan-200">Nostr map.</span>
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-300 sm:text-lg">
              A live check for the NCC-Server stack. Confirm this page is being served, then look up the signed locator that points clients back here.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-slate-950/55 p-5 shadow-2xl shadow-black/20 backdrop-blur sm:p-6">
            <div className="mb-4 flex items-center gap-2 text-xs font-semibold tracking-[0.16em] text-slate-400">
              <Server size={15} aria-hidden="true" /> THIS PAGE IS SERVED FROM
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.035] p-3">
              <code className="min-w-0 flex-1 truncate text-sm text-cyan-100 sm:text-base">{window.location.origin}</code>
              <button type="button" onClick={handleCopy} aria-label="Copy this host address" className="grid size-9 shrink-0 place-items-center rounded-lg text-slate-300 transition hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">
                {copied ? <Check size={17} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              </button>
            </div>
            <div className="mt-4 flex items-center justify-between text-sm">
              <span className="text-slate-400">HTTP response</span>
              <span className="flex items-center gap-2 text-slate-200">
                {hostState === 'online' ? <Check size={15} className="text-emerald-300" aria-hidden="true" /> : <span className="size-1.5 rounded-full bg-slate-500" />}
                {hostState === 'online' ? `200 OK · ${hostLatency ?? '—'} ms` : hostState === 'error' ? 'Unavailable' : 'Waiting for response'}
              </span>
            </div>
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
          <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-6 sm:p-8">
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <div className="mb-3 grid size-10 place-items-center rounded-xl bg-violet-300/10 text-violet-200"><Radio size={19} aria-hidden="true" /></div>
                <h2 className="text-xl font-semibold text-white">Check the locator</h2>
                <p className="mt-2 text-sm leading-6 text-slate-400">Query a relay for a fresh, signed Kind 30058 record.</p>
              </div>
              <span className="rounded-md border border-white/10 px-2 py-1 font-mono text-[11px] text-slate-400">NCC-05</span>
            </div>

            <form onSubmit={handleLookup} className="space-y-3">
              <label htmlFor="locator-npub" className="text-xs font-medium tracking-wide text-slate-300">LOCATOR AUTHOR NPUB</label>
              <Input
                id="locator-npub"
                value={npub}
                onChange={(event) => setNpub(event.target.value)}
                placeholder="npub1…"
                autoComplete="off"
                spellCheck={false}
                className="h-12 rounded-xl border-white/10 bg-black/20 font-mono text-sm text-white placeholder:text-slate-600 focus-visible:border-cyan-200/60 focus-visible:ring-cyan-200/20"
              />
              <Button type="submit" disabled={lookupState === 'loading' || !npub.trim()} className="h-11 w-full rounded-xl bg-cyan-200 font-semibold text-slate-950 hover:bg-cyan-100 disabled:opacity-50">
                {lookupState === 'loading' ? <><span className="mr-2 size-4 animate-spin rounded-full border-2 border-slate-950/30 border-t-slate-950" />Querying relays</> : <><Search size={16} className="mr-2" aria-hidden="true" />Verify locator</>}
              </Button>
            </form>

            <div className="mt-5 flex flex-wrap gap-2" aria-label="Relays queried">
              {relayList.map((relay) => <span key={relay} className="rounded-full border border-white/10 px-2.5 py-1 font-mono text-[10px] text-slate-400">{relay.replace('wss://', '').replace(/\/$/, '')}</span>)}
            </div>
              <p className="mt-4 text-xs leading-5 text-slate-500">Only the public key is used for lookup. Never paste an nsec here. The saved test npub is prefilled when configured.</p>
          </div>

          <div className="min-h-[310px] rounded-2xl border border-white/10 bg-slate-950/55 p-6 sm:p-8">
            {lookupState === 'idle' && (
              <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center">
                <div className="mb-4 grid size-14 place-items-center rounded-2xl border border-white/10 bg-white/[0.035] text-slate-400"><ShieldCheck size={23} aria-hidden="true" /></div>
                <h3 className="text-lg font-medium text-white">Locator verification</h3>
                <p className="mt-2 max-w-sm text-sm leading-6 text-slate-400">Enter the service owner’s npub to check relay publication, signature, freshness, and advertised endpoint.</p>
              </div>
            )}
            {lookupState === 'loading' && <div className="flex min-h-[260px] items-center justify-center text-sm text-slate-300">Waiting for relay responses…</div>}
            {lookupState === 'error' && <div role="alert" className="flex min-h-[260px] flex-col items-center justify-center text-center"><span className="mb-3 text-rose-300">Lookup could not complete</span><p className="max-w-md text-sm leading-6 text-slate-400">{lookupError}</p></div>}
            {lookupState === 'empty' && <div className="flex min-h-[260px] flex-col items-center justify-center text-center"><span className="mb-3 text-amber-200">No fresh locator found</span><p className="max-w-md text-sm leading-6 text-slate-400">The author has no matching public web locator on these relays, or its TTL has expired. Check the sidecar service mode, relay list, and publish logs.</p><p className="mt-3 font-mono text-xs text-slate-500">{lookupDetails}</p></div>}
            {lookupState === 'found' && locator && (
              <div>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-5">
                  <div className="flex items-center gap-2 text-emerald-200"><span className="grid size-7 place-items-center rounded-full bg-emerald-300/10"><Check size={15} aria-hidden="true" /></span><span className="font-medium">Fresh locator verified</span></div>
                  <span className="rounded-full border border-emerald-300/20 bg-emerald-300/5 px-2.5 py-1 text-xs text-emerald-100">Kind 30058</span>
                </div>
                <div className="grid gap-5 py-5 sm:grid-cols-2">
                  <div><div className="text-xs tracking-wide text-slate-500">IDENTIFIER</div><code className="mt-1 block text-sm text-slate-200">{locator.event.tags.find(([name]) => name === 'd')?.[1]}</code></div>
                  <div><div className="text-xs tracking-wide text-slate-500">EXPIRES</div><div className="mt-1 text-sm text-slate-200">{new Date(locator.expiresAt * 1000).toLocaleString()}</div></div>
                </div>
                <div className="space-y-3">
                  {locator.payload.endpoints.map((endpoint, index) => {
                    const url = safeEndpoint(endpoint.url ?? endpoint.uri);
                    const matches = url ? new URL(url).host === window.location.host : false;
                    const privateEndpoint = url ? isPrivateNetworkHost(new URL(url).hostname) : false;
                    const status = privateEndpoint ? 'Private network test endpoint' : window.location.protocol === 'ncc:' ? 'Resolved through NCC Browser' : matches ? 'Matches this page' : 'Different host';
                    const statusColor = privateEndpoint ? 'text-amber-200' : matches || window.location.protocol === 'ncc:' ? 'text-emerald-200' : 'text-amber-200';
                    const statusDot = privateEndpoint ? 'bg-amber-300' : matches || window.location.protocol === 'ncc:' ? 'bg-emerald-300' : 'bg-amber-300';
                    return (
                      <div key={`${url ?? 'endpoint'}-${index}`} className="rounded-xl border border-white/10 bg-white/[0.035] p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs text-slate-400">ADVERTISED ENDPOINT</span>
                          {url && <span className={`flex items-center gap-1.5 text-xs ${statusColor}`}><span className={`size-1.5 rounded-full ${statusDot}`} />{status}</span>}
                        </div>
                        {url ? <a href={url} target="_blank" rel="noreferrer" className="mt-2 flex items-center gap-2 break-all text-base font-medium text-cyan-100 underline decoration-cyan-100/20 underline-offset-4 hover:decoration-cyan-100"><span>{url}</span><ArrowUpRight size={15} className="shrink-0" aria-hidden="true" /></a> : <p className="mt-2 text-sm text-slate-400">Endpoint {index + 1} has no valid HTTP URL.</p>}
                        <div className="mt-2 text-xs text-slate-500">{[endpoint.protocol, endpoint.family, typeof endpoint.priority === 'number' && Number.isFinite(endpoint.priority) ? `priority ${endpoint.priority}` : null].filter(Boolean).join(' · ') || 'Public endpoint'}</div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-5 break-all font-mono text-[10px] leading-5 text-slate-500">event {locator.event.id}</div>
              </div>
            )}
          </div>
        </section>

        <section className="mt-5 grid gap-4 sm:grid-cols-3">
          {[
            { label: 'STATIC CONTENT', value: 'Caddy · file server', detail: 'Served from the host content root' },
            { label: 'LOCATOR', value: 'Nostr · kind 30058', detail: 'Signed and TTL-checked in browser' },
            { label: 'HOST RESPONSE', value: hostState === 'online' ? `${hostLatency ?? '—'} ms` : hostState === 'error' ? 'Unreachable' : 'Checking', detail: 'HEAD request to this page origin' },
          ].map((item) => (
            <div key={item.label} className="rounded-xl border border-white/10 bg-white/[0.025] px-5 py-4">
              <div className="text-[10px] font-semibold tracking-[0.16em] text-slate-500">{item.label}</div>
              <div className="mt-2 text-sm font-medium text-slate-200">{item.value}</div>
              <div className="mt-1 text-xs text-slate-500">{item.detail}</div>
            </div>
          ))}
        </section>

        <footer className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <span>Test page for the NCC-Server host stack.</span>
          <a href="https://soapbox.pub/mkstack" target="_blank" rel="noreferrer" className="w-fit text-slate-300 underline decoration-white/20 underline-offset-4 hover:text-white">Vibed with MKStack <ArrowUpRight size={12} className="ml-1 inline" aria-hidden="true" /></a>
        </footer>
      </div>
    </main>
  );
};

export default Index;

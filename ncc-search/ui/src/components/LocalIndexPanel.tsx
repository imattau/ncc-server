import { useEffect, useState } from 'react';
import { Pause, Play, Settings2, Trash2 } from 'lucide-react';

import { useLocalCrawlStatus } from '@/hooks/useLocalCrawlStatus';
import {
  clearLocalIndex,
  currentSettings,
  getLocalBootError,
  pauseLocalCrawl,
  resumeLocalCrawl,
  updateLocalSettings,
} from '@/lib/local/client';
import { DEFAULT_SETTINGS, parseRelayInput } from '@/lib/local/settings';
import type { LocalSettings } from '@/lib/local/types';
import { cn } from '@/lib/utils';

function formatBytes(bytes: number | null): string | null {
  // `navigator.storage.estimate()` reports a small non-zero figure right
  // after the first transaction and climbs as IndexedDB compacts, so an
  // early "2 KB" next to thousands of rows would just look wrong. Show the
  // number once it is at least a megabyte, which is when it becomes useful.
  if (bytes == null || bytes < 1024 * 1024) return null;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeTime(ms: number | null): string {
  if (!ms) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const BUTTON =
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/**
 * The nsite edition's own status line: what this browser has crawled, from
 * which relays, and whether the crawl is still running. It exists because the
 * reader cannot otherwise tell "no results" from "not crawled yet" -- and
 * because a local index should never borrow the server's reassuring copy.
 */
export function LocalIndexPanel({ className }: { className?: string }) {
  const status = useLocalCrawlStatus();
  const [open, setOpen] = useState(false);
  const [stalled, setStalled] = useState(false);

  // A worker that fails to boot never posts a status, so without this the
  // panel would say "Starting…" forever with no explanation. The boot error
  // is usually all a reader needs ("IndexedDB unavailable", a bad relay list,
  // or a CSP block in the browser).
  useEffect(() => {
    if (status) return;
    const timer = setTimeout(() => setStalled(true), 20_000);
    return () => clearTimeout(timer);
  }, [status]);

  if (!status) {
    const bootError = getLocalBootError();
    return (
      <p className={cn('text-xs', bootError || stalled ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground', className)} role="status">
        {bootError
          ? `The local index could not start: ${bootError}`
          : stalled
            ? 'The local index did not start. Reload the page to try again.'
            : 'Starting the local index…'}
      </p>
    );
  }

  const busy = status.phase === 'crawling' || status.phase === 'loading';
  const bytes = formatBytes(status.bytesStored);
  const activity =
    status.phase === 'loading'
      ? `building index… ${Math.round(status.loadProgress * 100)}%`
      : status.phase === 'crawling'
        ? (status.activity ?? 'crawling…')
        : status.phase === 'paused'
          ? 'paused'
          : status.phase === 'error'
            ? (status.activity ?? 'crawl stopped')
            : `synced ${relativeTime(status.lastSuccessfulSyncAt)}`;

  return (
    <div
      className={cn(
        'rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-foreground">Local index</span>
          <span aria-hidden="true">·</span>
          <span>{status.recordCount.toLocaleString()} records</span>
          <span aria-hidden="true">·</span>
          <span>
            {status.relays.length} relay{status.relays.length === 1 ? '' : 's'}
          </span>
          <span aria-hidden="true">·</span>
          <span className={cn(busy && 'text-foreground')} role="status">
            {activity}
          </span>
          {bytes && (
            <span className="hidden items-center gap-x-2 sm:flex">
              <span aria-hidden="true">·</span>
              <span>{bytes}</span>
            </span>
          )}
        </span>

        <span className="ml-auto flex items-center gap-0.5">
          {status.phase === 'paused' ? (
            <button type="button" className={BUTTON} onClick={resumeLocalCrawl} title="Resume crawling">
              <Play className="size-3" aria-hidden="true" />
              Resume
            </button>
          ) : (
            <button
              type="button"
              className={BUTTON}
              onClick={pauseLocalCrawl}
              disabled={status.phase === 'loading'}
              title="Pause crawling"
            >
              <Pause className="size-3" aria-hidden="true" />
              Pause
            </button>
          )}
          <button
            type="button"
            className={BUTTON}
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            title="Local index settings"
          >
            <Settings2 className="size-3" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Settings</span>
          </button>
        </span>
      </div>

      <p className="mt-1 text-[11px] text-muted-foreground/80">
        Crawled by this browser while the tab is open. Relay data only — endpoints are not fetched or
        verified here.
      </p>

      {open && <LocalIndexSettings onClose={() => setOpen(false)} />}
    </div>
  );
}

function LocalIndexSettings({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<LocalSettings>(currentSettings());
  const [relaysText, setRelaysText] = useState(settings.relays.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  function save() {
    const relays = parseRelayInput(relaysText);
    if (relays.length === 0) {
      setError('Enter at least one wss:// relay.');
      return;
    }
    setError(null);
    updateLocalSettings({ ...settings, relays });
    onClose();
  }

  function clear() {
    if (!window.confirm('Delete the local index and crawl cursors from this browser?')) return;
    setClearing(true);
    clearLocalIndex();
    setClearing(false);
    onClose();
  }

  return (
    <div className="mt-2 grid gap-2 border-t border-border pt-2">
      <label className="grid gap-1">
        <span className="text-[11px] font-medium text-foreground">Relays to crawl</span>
        <textarea
          value={relaysText}
          onChange={(event) => setRelaysText(event.target.value)}
          rows={3}
          spellCheck={false}
          className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
        />
      </label>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <label className="flex items-center gap-1.5 text-[11px]">
          <span className="text-foreground">Depth</span>
          <select
            value={settings.depth}
            onChange={(event) => setSettings({ ...settings, depth: Number(event.target.value) })}
            className="rounded border border-border bg-background px-1 py-0.5 text-[11px] text-foreground"
          >
            {[1, 2, 3, 4, 6, 8, 10].map((depth) => (
              <option key={depth} value={depth}>
                {depth} page{depth === 1 ? '' : 's'} per kind
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[11px]">
          <input
            type="checkbox"
            checked={settings.includeProfiles}
            onChange={(event) => setSettings({ ...settings, includeProfiles: event.target.checked })}
          />
          <span className="text-foreground">Index profiles too</span>
        </label>
      </div>

      {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          className="rounded bg-foreground px-2 py-1 text-[11px] font-medium text-background"
        >
          Save and restart crawl
        </button>
        <button
          type="button"
          onClick={() => {
            setSettings(DEFAULT_SETTINGS);
            setRelaysText(DEFAULT_SETTINGS.relays.join('\n'));
          }}
          className={BUTTON}
        >
          Defaults
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={clearing}
          className={cn(BUTTON, 'ml-auto text-red-600 hover:text-red-700 dark:text-red-400')}
        >
          <Trash2 className="size-3" aria-hidden="true" />
          Clear index
        </button>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Pause, Play, Trash2 } from 'lucide-react';

import { useLocalCrawlStatus } from '@/hooks/useLocalCrawlStatus';
import {
  clearLocalIndex,
  currentSettings,
  pauseLocalCrawl,
  resumeLocalCrawl,
  updateLocalSettings,
} from '@/lib/local/client';
import { DEFAULT_SETTINGS, MAX_BYTES_OPTIONS, deriveMaxRows, parseRelayInput } from '@/lib/local/settings';
import type { LocalSettings } from '@/lib/local/types';
import { crawlActivity, formatBytes } from '@/lib/local/format';
import { cn } from '@/lib/utils';

const BUTTON =
  'inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-h-9 sm:px-2.5 sm:text-xs pointer-coarse:min-h-11 pointer-coarse:text-sm';

const FIELD =
  'min-h-11 rounded-md border border-border bg-background px-2.5 text-base text-foreground sm:min-h-9 sm:text-sm pointer-coarse:min-h-11 pointer-coarse:text-base';

/**
 * The nsite edition's crawl controls, inside the shared settings sheet.
 *
 * The status strip on the page keeps only the quick pause/resume action; every
 * knob lives here so there is one place to change them and one place to explain
 * what the browser is doing. Sizes are deliberately larger than the old inline
 * form: this is the surface that was unreadably small on phones.
 */
export function LocalIndexSettings({ nip65Active }: { nip65Active: boolean }) {
  const status = useLocalCrawlStatus();
  const [settings, setSettings] = useState<LocalSettings>(() => currentSettings());
  const [relaysText, setRelaysText] = useState(() => currentSettings().relays.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [saved, setSaved] = useState(false);

  // The relay source can change while the sheet is open (the NIP-65 list
  // arrives, or the reader switches back). Re-read the effective settings so
  // the textarea does not show a stale list.
  const effectiveRelayKey = currentSettings().relays.join(',');
  useEffect(() => {
    const current = currentSettings();
    setSettings(current);
    setRelaysText(current.relays.join('\n'));
  }, [effectiveRelayKey, nip65Active]);

  function save() {
    const relays = nip65Active ? settings.relays : parseRelayInput(relaysText);
    if (relays.length === 0) {
      setError('Enter at least one wss:// relay.');
      return;
    }
    setError(null);
    updateLocalSettings({ ...settings, relays });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
  }

  function clear() {
    if (!window.confirm('Delete the local index and crawl cursors from this browser?')) return;
    setClearing(true);
    clearLocalIndex();
    setClearing(false);
  }

  if (!status) {
    return <p className="text-sm text-muted-foreground">The local index is starting…</p>;
  }

  const busy = status.phase === 'crawling' || status.phase === 'loading';
  const bytes = formatBytes(status.bytesStored);

  return (
    <div className="grid gap-4">
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-foreground">{status.recordCount.toLocaleString()} records</span>
          <span aria-hidden="true" className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">
            {status.relays.length} relay{status.relays.length === 1 ? '' : 's'}
          </span>
          <span aria-hidden="true" className="text-muted-foreground">·</span>
          <span className={cn('text-muted-foreground', busy && 'text-foreground')} role="status">
            {crawlActivity(status)}
          </span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {bytes ? `${bytes} stored. ` : ''}Crawled by this browser while the tab is open. Relay data only —
          endpoints are not fetched or verified here.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {status.phase === 'paused' ? (
          <button type="button" className={BUTTON} onClick={resumeLocalCrawl}>
            <Play className="size-4" aria-hidden="true" />
            Resume crawling
          </button>
        ) : (
          <button type="button" className={BUTTON} onClick={pauseLocalCrawl} disabled={status.phase === 'loading'}>
            <Pause className="size-4" aria-hidden="true" />
            Pause crawling
          </button>
        )}
      </div>

      <label className="grid gap-1.5">
        <span className="text-sm font-medium text-foreground">Relays to crawl</span>
        <textarea
          value={relaysText}
          onChange={(event) => setRelaysText(event.target.value)}
          rows={3}
          spellCheck={false}
          disabled={nip65Active}
          className={cn(
            'w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-sm text-foreground disabled:opacity-70',
            'pointer-coarse:text-base',
          )}
        />
        {nip65Active && (
          <span className="text-xs text-muted-foreground">
            Using your NIP-65 read relays. Switch to site relays above to edit this list.
          </span>
        )}
      </label>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-foreground">Depth</span>
          <select
            value={settings.depth}
            onChange={(event) => setSettings({ ...settings, depth: Number(event.target.value) })}
            className={FIELD}
          >
            {[1, 2, 3, 4, 6, 8, 10].map((depth) => (
              <option key={depth} value={depth}>
                {depth} page{depth === 1 ? '' : 's'} per kind
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-foreground">Index limit</span>
          <select
            value={settings.maxBytes}
            onChange={(event) => setSettings({ ...settings, maxBytes: Number(event.target.value) })}
            className={FIELD}
          >
            {MAX_BYTES_OPTIONS.map(({ bytes: optionBytes, label }) => (
              <option key={optionBytes} value={optionBytes}>
                {label}
              </option>
            ))}
            {!MAX_BYTES_OPTIONS.some((option) => option.bytes === settings.maxBytes) && (
              <option value={settings.maxBytes}>
                {Math.round(settings.maxBytes / (1024 * 1024))} MB
              </option>
            )}
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm pointer-coarse:min-h-11">
          <input
            type="checkbox"
            checked={settings.includeProfiles}
            onChange={(event) => setSettings({ ...settings, includeProfiles: event.target.checked })}
            className="size-5 rounded border-border"
          />
          <span className="text-foreground">Index profiles too</span>
        </label>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Up to about {deriveMaxRows(settings.maxBytes).toLocaleString()} records; the oldest are pruned first
        when the limit is reached. Everything stays in this browser, and the limit is never more than half
        the storage the browser is willing to give this site.
      </p>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {saved && <p className="text-sm text-emerald-700 dark:text-emerald-400">Saved.</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          className="min-h-11 rounded-md bg-foreground px-3 text-sm font-medium text-background pointer-coarse:min-h-11"
        >
          Save and restart crawl
        </button>
        <button
          type="button"
          onClick={() => {
            setSettings(DEFAULT_SETTINGS);
            setRelaysText(DEFAULT_SETTINGS.relays.join('\n'));
          }}
          disabled={nip65Active}
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
          <Trash2 className="size-4" aria-hidden="true" />
          Clear index
        </button>
      </div>
    </div>
  );
}

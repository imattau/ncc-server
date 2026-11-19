// Formatting helpers shared by the local-index status strip and its settings
// sheet. They lived inside LocalIndexPanel until the settings form moved into
// the app-wide sheet; keeping one copy avoids the two views drifting apart.

export function formatBytes(bytes: number | null): string | null {
  // `navigator.storage.estimate()` reports a small non-zero figure right
  // after the first transaction and climbs as IndexedDB compacts, so an
  // early "2 KB" next to thousands of rows would just look wrong. Show the
  // number once it is at least a megabyte, which is when it becomes useful.
  if (bytes == null || bytes < 1024 * 1024) return null;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function relativeTime(ms: number | null): string {
  if (!ms) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function crawlActivity(status: {
  phase: string;
  loadProgress: number;
  activity: string | null;
  lastSuccessfulSyncAt: number | null;
}): string {
  if (status.phase === 'loading') return `building index… ${Math.round(status.loadProgress * 100)}%`;
  if (status.phase === 'crawling') return status.activity ?? 'crawling…';
  if (status.phase === 'paused') return 'paused';
  if (status.phase === 'error') return status.activity ?? 'crawl stopped';
  return `synced ${relativeTime(status.lastSuccessfulSyncAt)}`;
}

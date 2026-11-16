// Orchestrates the npack adapter: a release (kind:9900) and its artifact
// (kind:1063) are two separate events from the same publisher that can
// arrive in either order over the ambient relay subscription, unlike every
// other adapter here where one discovered event is already the full
// record. A release is stored as soon as it's seen either way (so it's
// searchable by name/summary/description immediately); if its artifact
// hasn't arrived yet, the row is re-upserted with the download URL/MIME
// type once it does -- `store.upsertRow`'s COALESCE semantics (see
// store.js) mean that second upsert only fills in `media_url`/`media_type`,
// never blanks anything already indexed.

import {
  discoverNpackReleases,
  discoverNpackArtifacts,
  resolveNpackRelease,
  resolveNpackArtifact,
  toSearchRow,
} from './npack.js';
import { takeSeenRelays } from '../relayTracking.js';

// Bounds memory for publishers who publish an artifact long before (or
// without ever) publishing the release that references it -- an unbounded
// cache would grow for as long as the process runs. FIFO eviction (Map
// insertion order) is good enough here: this is only a lookup cache for
// joining two events, not the index itself, which store.js already governs
// separately (NCC_SEARCH_DB_MAX_BYTES).
const ARTIFACT_CACHE_MAX = 10_000;
const PENDING_RELEASES_MAX = 10_000;

/**
 * @param {import('../config.js').config} config
 * @param {ReturnType<typeof import('../store.js').openStore>} store
 * @param {import('nostr-tools').SimplePool} pool shared with the other crawlers
 */
export function startNpackCrawler(config, store, pool) {
  /** @type {Map<string, import('./npack.js').ResolvedNpackArtifact>} artifact event id -> resolved artifact */
  const artifactCache = new Map();
  /** @type {Map<string, Array<{ release: import('./npack.js').ResolvedNpackRelease, seenRelays: string[] }>>} artifact event id -> releases waiting on it */
  const pendingReleases = new Map();

  function cacheArtifact(id, artifact) {
    artifactCache.delete(id); // re-insert at the end, so eviction stays FIFO even on a re-publish
    artifactCache.set(id, artifact);
    if (artifactCache.size > ARTIFACT_CACHE_MAX) {
      artifactCache.delete(artifactCache.keys().next().value);
    }
  }

  function storeRelease(release, artifact, seenRelays) {
    store.upsertContent(toSearchRow(release, artifact), null, seenRelays);
  }

  function ingestRelease(event) {
    const release = resolveNpackRelease(event);
    if (!release) return;
    const seenRelays = takeSeenRelays(pool, event.id);
    const artifact = artifactCache.get(release.artifactId) ?? null;
    storeRelease(release, artifact, seenRelays);
    if (!artifact) {
      const waiting = pendingReleases.get(release.artifactId) ?? [];
      waiting.push({ release, seenRelays });
      pendingReleases.set(release.artifactId, waiting);
      if (pendingReleases.size > PENDING_RELEASES_MAX) {
        pendingReleases.delete(pendingReleases.keys().next().value);
      }
    }
  }

  function ingestArtifact(event) {
    const artifact = resolveNpackArtifact(event);
    if (!artifact) return;
    cacheArtifact(artifact.id, artifact);
    const waiting = pendingReleases.get(artifact.id);
    if (!waiting) return;
    pendingReleases.delete(artifact.id);
    for (const { release, seenRelays } of waiting) {
      storeRelease(release, artifact, seenRelays);
    }
  }

  const releaseSub = discoverNpackReleases(pool, config.relays, ingestRelease, { store, monitor: config.crawlMonitor });
  const artifactSub = discoverNpackArtifacts(pool, config.relays, ingestArtifact, { store, monitor: config.crawlMonitor });

  return {
    ingestRelease,
    ingestArtifact,
    stop() {
      releaseSub.close();
      artifactSub.close();
    },
  };
}

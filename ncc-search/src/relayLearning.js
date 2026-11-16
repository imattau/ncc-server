import { verifyEvent } from 'nostr-tools';

const AUTHOR_CHECK_BATCH = 5;
const MIN_SUPPORTING_AUTHORS = 3;
const MAX_LEARNED_RELAYS = 10;
const RECOMMENDATION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
const PROBE_TIMEOUT_MS = 8_000;
const PROMOTION_CANDIDATE_LIMIT = 30;
const MAX_PROMOTION_PROBES_PER_TICK = 2;
const CANDIDATE_PROBE_COOLDOWN_SECONDS = 6 * 60 * 60;
const LEARNED_RELAY_RECHECK_SECONDS = 6 * 60 * 60;

function parseReadRelays(event) {
  const result = new Set();
  for (const tag of event.tags ?? []) {
    if (tag[0] !== 'r' || typeof tag[1] !== 'string') continue;
    const marker = tag[2];
    if (marker && marker !== 'read') continue;
    const url = safeRelayUrl(tag[1]);
    if (url) result.add(url);
  }
  return [...result];
}

function safeRelayUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'wss:' || url.username || url.password || url.hash) return null;
    const host = url.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null;
    if (isPrivateIp(host)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function isPrivateIp(host) {
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if ([a, b].some((part) => part > 255)) return true;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const ipv6 = host.replace(/^\[|\]$/g, '').toLowerCase();
  return ipv6 === '::' || ipv6 === '::1' || ipv6.startsWith('::ffff:') || ipv6.startsWith('fc') || ipv6.startsWith('fd') || ipv6.startsWith('fe8') || ipv6.startsWith('fe9') || ipv6.startsWith('fea') || ipv6.startsWith('feb');
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('relay query timed out')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Queries NIP-65 lists for indexed authors and promotes well-supported relays. */
export function startRelayLearning(config, store, pool, relayRegistry) {
  if (!config.learnRelays) return { snapshot: () => ({ enabled: false, candidateCount: 0, learnedCount: 0 }), stop() {} };

  let stopped = false;
  let busy = false;
  const configured = new Set(config.relays);
  const learned = new Set();
  const needsProbe = new Set();
  const nextHealthProbeAt = new Map();
  const failedProbeAt = new Map(store.listRelayCandidateProbes().map((item) => [item.url, item.lastProbeAt]));

  for (const relay of store.listLearnedRelays()) {
    learned.add(relay.url);
    needsProbe.add(relay.url);
    relayRegistry.add(relay.url);
  }

  async function queryAuthor(pubkey) {
    try {
      const events = await withTimeout(pool.querySync(config.relays, { kinds: [10002], authors: [pubkey] }), PROBE_TIMEOUT_MS);
      const latestById = new Map();
      for (const event of events) {
        if (event.pubkey !== pubkey || event.kind !== 10002 || !verifyEvent(event)) continue;
        const current = latestById.get(event.pubkey);
        if (!current || event.created_at > current.created_at) latestById.set(event.pubkey, event);
      }
      const event = latestById.get(pubkey);
      if (event) store.saveNip65RelayList(pubkey, event.created_at, parseReadRelays(event));
      store.markNip65AuthorChecked(pubkey);
    } catch (error) {
      store.markNip65AuthorChecked(pubkey, Math.floor(Date.now() / 1000) - 6 * 24 * 60 * 60);
      console.warn(`[ncc-search] NIP-65 lookup failed for ${pubkey}: ${error.message}`);
    }
  }

  async function probe(relay) {
    try {
      await withTimeout(pool.querySync([relay], { kinds: [10002], limit: 1 }), PROBE_TIMEOUT_MS);
      return true;
    } catch (error) {
      return false;
    }
  }

  async function promoteCandidates() {
    const current = Math.floor(Date.now() / 1000);
    const allCandidates = store.listNip65RelayCandidates({ now: current, maxAgeSeconds: RECOMMENDATION_MAX_AGE_SECONDS });
    for (const url of [...learned]) {
      const support = allCandidates.find((item) => item.url === url)?.authorCount ?? 0;
      if (support < MIN_SUPPORTING_AUTHORS) {
        relayRegistry.remove(url);
        store.removeLearnedRelay(url);
        learned.delete(url);
        nextHealthProbeAt.delete(url);
        console.log(`[ncc-search] demoted learned relay ${url} (support fell below threshold)`);
      }
    }
    const ranked = allCandidates
      .filter(({ url, authorCount }) => !configured.has(url) && authorCount >= MIN_SUPPORTING_AUTHORS)
      .filter(({ url }) => !learned.has(url) && current - (failedProbeAt.get(url) ?? 0) >= CANDIDATE_PROBE_COOLDOWN_SECONDS);
    const eligible = ranked.slice(0, PROMOTION_CANDIDATE_LIMIT);
    let probes = 0;
    for (const candidate of eligible) {
      if (stopped) return;
      if (learned.has(candidate.url)) continue;
      if (probes >= MAX_PROMOTION_PROBES_PER_TICK) break;
      probes++;
      if (await probe(candidate.url)) {
        if (learned.size >= MAX_LEARNED_RELAYS) {
          const weakest = [...learned].map((url) => ({ url, count: store.listNip65RelayCandidates({ now: current, maxAgeSeconds: RECOMMENDATION_MAX_AGE_SECONDS }).find((item) => item.url === url)?.authorCount ?? 0 }))
            .sort((a, b) => a.count - b.count)[0];
          if (!weakest || candidate.authorCount <= weakest.count) continue;
          relayRegistry.remove(weakest.url);
          store.removeLearnedRelay(weakest.url);
          learned.delete(weakest.url);
          nextHealthProbeAt.delete(weakest.url);
          console.log(`[ncc-search] demoted learned relay ${weakest.url} (${weakest.count} supporting authors)`);
        }
        learned.add(candidate.url);
        store.saveLearnedRelay(candidate.url);
        store.recordLearnedRelayProbe(candidate.url, null);
        relayRegistry.add(candidate.url);
        nextHealthProbeAt.set(candidate.url, current + LEARNED_RELAY_RECHECK_SECONDS);
        console.log(`[ncc-search] learned relay ${candidate.url} (${candidate.authorCount} supporting authors)`);
      } else {
        const reason = 'relay probe failed or timed out';
        failedProbeAt.set(candidate.url, current);
        store.recordRelayCandidateProbe(candidate.url, reason);
      }
    }
  }

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      for (const [relay, dueAt] of nextHealthProbeAt) {
        if (dueAt > Math.floor(Date.now() / 1000)) continue;
        needsProbe.add(relay);
      }
      let healthChecks = 0;
      for (const relay of [...needsProbe]) {
        if (healthChecks >= 2) break;
        needsProbe.delete(relay);
        healthChecks++;
        if (!(await probe(relay))) {
          store.recordLearnedRelayProbe(relay, 'relay probe failed or timed out');
          const failedAt = Math.floor(Date.now() / 1000);
          failedProbeAt.set(relay, failedAt);
          store.recordRelayCandidateProbe(relay, 'relay probe failed or timed out');
          learned.delete(relay);
          nextHealthProbeAt.delete(relay);
          store.removeLearnedRelay(relay);
          relayRegistry.remove(relay);
          console.warn(`[ncc-search] removed unreachable learned relay ${relay}`);
        } else {
          store.recordLearnedRelayProbe(relay, null);
          nextHealthProbeAt.set(relay, Math.floor(Date.now() / 1000) + LEARNED_RELAY_RECHECK_SECONDS);
        }
      }
      const authors = store.listNip65AuthorsToCheck(AUTHOR_CHECK_BATCH);
      await Promise.all(authors.map(queryAuthor));
      await promoteCandidates();
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => { tick().catch((error) => console.error('[ncc-search] relay learning tick failed:', error)); }, config.tickIntervalMs);
  tick().catch((error) => console.error('[ncc-search] relay learning startup failed:', error));

  return {
    snapshot() {
      const rows = store.listNip65RelayCandidates({ maxAgeSeconds: RECOMMENDATION_MAX_AGE_SECONDS });
      return {
        enabled: true,
        candidateCount: rows.filter((row) => row.authorCount >= MIN_SUPPORTING_AUTHORS).length,
        learnedCount: learned.size,
        minimumSupportingAuthors: MIN_SUPPORTING_AUTHORS,
        maximumLearnedRelays: MAX_LEARNED_RELAYS,
        relays: [...learned].map((url) => ({
          url,
          supportingAuthors: rows.find((row) => row.url === url)?.authorCount ?? 0,
        })),
      };
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export { parseReadRelays, safeRelayUrl };

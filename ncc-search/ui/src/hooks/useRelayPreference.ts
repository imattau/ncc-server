import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNostr } from '@nostrify/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  currentSettings,
  isLocalMode,
  updateLocalSettings,
} from '@/lib/local/client';
import {
  activeRelays,
  loadRelayPreference,
  saveRelayPreference,
  siteRelays,
  type RelayPreference,
} from '@/lib/local/settings';
import { KIND_RELAY_LIST, newestRelayList, readRelaysFromEvent } from '@/lib/nip65';

const EMPTY: RelayPreference = { source: 'site', pubkey: null, relays: [], siteRelays: [] };

function sameRelays(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((relay, index) => relay === b[index]);
}

/**
 * The signed-in reader's choice between the site's relays and their own
 * NIP-65 read relays.
 *
 * The preference is stored per origin. On the server-hosted edition it drives
 * browser-side lookups and the live-search `relays` parameter; in the nsite
 * edition it also replaces the crawl relay list. Switching back restores the
 * site list exactly as it was.
 */
export function useRelayPreference(pubkey: string | null) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const local = isLocalMode();
  const [preference, setPreference] = useState<RelayPreference>(
    () => loadRelayPreference() ?? EMPTY,
  );
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = useCallback((next: RelayPreference) => {
    const saved = saveRelayPreference(next);
    setPreference(saved);
    void queryClient.invalidateQueries({ queryKey: ['nostr'] });
    return saved;
  }, [queryClient]);

  // The cached list belongs to one key; a different signer (or a sign-out)
  // must not silently keep searching through someone else's relays.
  useEffect(() => {
    if (preference.source !== 'nip65') return;
    if (pubkey && preference.pubkey === pubkey) return;
    setRequesting(false);
    setError(null);
    commit({ ...preference, source: 'site', pubkey: null, relays: [] });
  }, [commit, preference, pubkey]);

  // The nsite edition's worker gets whatever is in effect. The hook is the
  // only place that changes the relay source and the crawl list together, so
  // `uiRelays()` and the worker cannot disagree.
  useEffect(() => {
    if (!local) return;
    const desired = preference.source === 'nip65' ? preference.relays : preference.siteRelays;
    if (!desired.length) return;
    const current = currentSettings();
    if (sameRelays(current.relays, desired)) return;
    updateLocalSettings({ ...current, relays: desired });
  }, [local, preference.relays, preference.siteRelays, preference.source]);

  const query = useQuery({
    queryKey: ['nip65-relays', pubkey ?? '', preference.relays.join(',')],
    queryFn: async () => {
      if (!pubkey) throw new Error('Sign in to use your relay list.');
      const events = await nostr.query(
        [{ kinds: [KIND_RELAY_LIST], authors: [pubkey], limit: 1 }],
        { signal: AbortSignal.timeout(5000) },
      );
      const newest = newestRelayList(events);
      if (!newest) throw new Error('No NIP-65 relay list found for this key.');
      const relays = readRelaysFromEvent(newest);
      if (!relays.length) throw new Error('Your NIP-65 list has no read relays.');
      return relays;
    },
    enabled: Boolean(pubkey) && (preference.source === 'nip65' || requesting),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  useEffect(() => {
    const onNip65 = preference.source === 'nip65';
    if (!requesting && !onNip65) return;
    if (query.isError) {
      setRequesting(false);
      setError(query.error instanceof Error ? query.error.message : 'Could not read your relay list.');
      return;
    }
    if (!query.data) return;
    setRequesting(false);
    setError(null);
    if (
      onNip65
      && preference.pubkey === pubkey
      && sameRelays(preference.relays, query.data)
    ) {
      return;
    }
    commit({
      source: 'nip65',
      pubkey,
      relays: query.data,
      siteRelays: preference.siteRelays.length ? preference.siteRelays : siteRelays(),
    });
    // `preference` is deliberately not a dependency: this effect reacts to a
    // completed fetch, and including the object it commits would re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requesting, query.isError, query.error, query.data, pubkey, commit, preference.source]);

  const useNip65 = useCallback(() => {
    setError(null);
    if (!pubkey) {
      setError('Sign in to use your relay list.');
      return;
    }
    if (preference.source === 'nip65' && preference.pubkey === pubkey && preference.relays.length) {
      // Already on it; a click means refresh.
      void query.refetch();
      return;
    }
    setRequesting(true);
  }, [preference, pubkey, query]);

  const useSite = useCallback(() => {
    setRequesting(false);
    setError(null);
    const restore = preference.siteRelays.length ? preference.siteRelays : siteRelays();
    commit({ source: 'site', pubkey: null, relays: preference.relays, siteRelays: restore });
  }, [commit, preference]);

  const refresh = useCallback(() => {
    if (preference.source !== 'nip65') return;
    setError(null);
    void query.refetch();
  }, [preference.source, query]);

  const loading = requesting || (preference.source === 'nip65' && query.isFetching);

  return useMemo(() => ({
    source: preference.source,
    /** The NIP-65 list, for the settings sheet and the server's `relays` param. */
    relays: preference.source === 'nip65' ? preference.relays : [],
    siteRelays: preference.siteRelays.length ? preference.siteRelays : activeRelays(),
    error,
    loading,
    useNip65,
    useSite,
    refresh,
  }), [error, loading, preference, refresh, useNip65, useSite]);
}

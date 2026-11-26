import { nip19 } from 'nostr-tools';

import { isNostrId } from '@/lib/nostrId';
import {
  NSITE_NAMED_KIND,
  NSITE_ROOT_KIND,
  NSITE_SNAPSHOT_KIND,
  hexToBase36,
  parseNsiteSubdomain,
  type ParsedNsiteSubdomain,
} from '@/lib/nsiteSubdomain';
import { decodeNip19 } from '@/lib/safeNip19';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

/**
 * A profile's `website` field, classified for display.
 *
 * `href` is the address to put in the anchor. For an nsite in a normal web
 * browser, `route` is Ditto's own detail route, which auto-opens the nsite
 * viewer; `href` remains the canonical `nsite://` address so NCC Browser can
 * handle it natively.
 *
 * `faviconUrl` is `null` when the link has no fetchable icon (an `ncc://`
 * service is only reachable after locator resolution), and `undefined` when
 * the link itself can be used as the icon URL.
 */
export interface ProfileWebsiteLink {
  kind: 'web' | 'ncc' | 'nsite';
  href: string;
  route?: string;
  label: string;
  title?: string;
  faviconUrl?: string | null;
  /** False for nsite forms NCC Browser cannot open natively (snapshots). */
  nativeNcc?: boolean;
}

/**
 * Whether the page is running inside NCC Browser (Nostr Navigator).
 *
 * Desktop serves NCC pages with a real `ncc:` protocol. Mobile proxies them
 * over `http://<pubkey>.<service>.localhost:<port>` and marks its user agent
 * with `NostrNavigator/<version>`, so the protocol alone is not enough.
 */
export function isNccBrowserContext(
  protocol: string,
  hostname: string,
  userAgent: string,
): boolean {
  return (
    protocol === 'ncc:' ||
    /\bNostrNavigator\/\d/.test(userAgent) ||
    (protocol === 'http:' && hostname.endsWith('.localhost'))
  );
}

/** NIP-5A's `d` tag rule for a named site. Mirrors ncc-browser's parser. */
const NSITE_SITE_ID = /^[a-z0-9-]{1,13}$/;

/** NCC's service-name rule, matching `ncc-browser` and `parseNccUri`. */
const NCC_SERVICE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

type NsiteTarget =
  | { kind: typeof NSITE_ROOT_KIND; pubkey: string; identifier: ''; path: string }
  | { kind: typeof NSITE_NAMED_KIND; pubkey: string; identifier: string; path: string }
  | { kind: typeof NSITE_SNAPSHOT_KIND; id: string; path: string };

/** Shorten a bech32 identifier for a human-readable link label. */
function shorten(value: string): string {
  if (value.length <= 20) return value;
  return `${value.slice(0, 12)}…${value.slice(-4)}`;
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** A valid NIP-5A named-site id (no trailing hyphen, same as ncc-browser). */
function isSiteId(value: string): boolean {
  return NSITE_SITE_ID.test(value) && !value.endsWith('-');
}

/** Decode an npub or 64-character hex host into a hex pubkey. */
function decodePubkey(value: string): string | undefined {
  if (isNostrId(value)) return value;
  if (!value.toLowerCase().startsWith('npub1')) return undefined;
  try {
    const decoded = decodeNip19(value);
    return decoded.type === 'npub' && isNostrId(decoded.data) ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify a kind 0 `website` value.
 *
 * Accepts the web URLs Ditto already showed, bare hostnames (normalised to
 * HTTPS), NCC Browser service addresses (`ncc://<npub>/<service>`), and
 * NIP-5A sites in both Ditto's host form (`nsite://<npub>` or
 * `nsite://<base36-pubkey><site>`) and NCC Browser's path form
 * (`nsite://<npub>/<site>/<path>`).
 *
 * Returns `undefined` for malformed or unsupported values, so the caller can
 * render nothing rather than an unsafe or dead link.
 */
export function parseProfileWebsite(raw: string | undefined | null): ProfileWebsiteLink | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  if (/^nsite:\/\//i.test(value)) return parseNsite(value);
  if (/^ncc:\/\//i.test(value)) return parseNcc(value);
  return parseWeb(value);
}

function parseWeb(value: string): ProfileWebsiteLink | undefined {
  // Keep the existing behaviour for bare domains: `example.com` is shown as
  // https://example.com. A value that already has a scheme is checked as-is,
  // so `javascript://…` and `http://…` are rejected by sanitizeUrl.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const href = sanitizeUrl(candidate);
  if (!href) return undefined;

  return {
    kind: 'web',
    href,
    label: href.replace(/^https:\/\//, '').replace(/\/$/, ''),
    faviconUrl: href,
  };
}

function parseNcc(value: string): ProfileWebsiteLink | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'ncc:') return undefined;

  const pubkey = decodePubkey(url.hostname.toLowerCase());
  if (!pubkey) return undefined;

  const rawPath = url.pathname.replace(/^\/+/, '');
  const slash = rawPath.indexOf('/');
  const first = slash === -1 ? rawPath : rawPath.slice(0, slash);

  const service = first ? safeDecode(first) : undefined;
  if (first && (!service || !NCC_SERVICE.test(service))) return undefined;

  const npub = nip19.npubEncode(pubkey);
  // Preserve the path exactly as supplied: the first segment is the service
  // (absent means the default `addr` service), and an explicit `/addr/…`
  // must not be mistaken for a path under another service.
  const href = `ncc://${npub}${url.pathname || '/'}${url.search}${url.hash}`;

  return {
    kind: 'ncc',
    href,
    label: `ncc://${shorten(npub)}${service ? `/${service}` : ''}`,
    title: href,
    // An ncc:// service has no web host until its locator is resolved.
    faviconUrl: null,
  };
}

function parseNsite(value: string): ProfileWebsiteLink | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'nsite:') return undefined;

  const host = url.hostname.toLowerCase();
  const path = url.pathname || '/';
  const target = parseNsiteTarget(host, path);
  if (!target) return undefined;

  const npub = target.kind === NSITE_SNAPSHOT_KIND ? undefined : nip19.npubEncode(target.pubkey);

  let href: string;
  let route: string;
  let label: string;
  let faviconUrl: string | undefined;

  if (target.kind === NSITE_SNAPSHOT_KIND) {
    const base36 = hexToBase36(target.id);
    href = `nsite://v${base36}${target.path}`;
    route = `/${nip19.neventEncode({ id: target.id })}`;
    label = 'nsite://snapshot';
    faviconUrl = `https://v${base36}.nsite.lol`;
  } else if (target.kind === NSITE_NAMED_KIND) {
    href = `nsite://${npub}/${target.identifier}${target.path}`;
    route = `/${nip19.naddrEncode({
      kind: NSITE_NAMED_KIND,
      pubkey: target.pubkey,
      identifier: target.identifier,
    })}`;
    label = `nsite://${shorten(npub!)}/${target.identifier}`;
    if (isSiteId(target.identifier)) {
      faviconUrl = `https://${hexToBase36(target.pubkey)}${target.identifier}.nsite.lol`;
    }
  } else {
    href = `nsite://${npub}${target.path}`;
    route = `/${nip19.naddrEncode({
      kind: NSITE_ROOT_KIND,
      pubkey: target.pubkey,
      identifier: '',
    })}`;
    label = `nsite://${shorten(npub!)}`;
    faviconUrl = `https://${npub}.nsite.lol`;
  }

  return {
    kind: 'nsite',
    href,
    route,
    label,
    title: href,
    faviconUrl,
    // ncc-browser's nsite parser handles npub and named-site hosts but not
    // the snapshot (`v<base36-id>`) form, so keep snapshots in Ditto's viewer.
    nativeNcc: target.kind !== NSITE_SNAPSHOT_KIND,
  };
}

function parseNsiteTarget(host: string, path: string): NsiteTarget | undefined {
  // NCC Browser's display form puts the named site in the path:
  // nsite://<npub>/<site>/<path>. A bare npub is the root site.
  const pubkey = decodePubkey(host);
  if (pubkey) {
    const rawPath = path.replace(/^\/+/, '');
    const slash = rawPath.indexOf('/');
    const first = slash === -1 ? rawPath : rawPath.slice(0, slash);
    const rest = slash === -1 ? '' : rawPath.slice(slash);
    const site = first ? safeDecode(first) : undefined;

    if (site && isSiteId(site)) {
      return { kind: NSITE_NAMED_KIND, pubkey, identifier: site, path: rest || '/' };
    }

    return {
      kind: NSITE_ROOT_KIND,
      pubkey,
      identifier: '',
      path: rawPath ? `/${rawPath}` : '/',
    };
  }

  // Ditto's host form: nsite://<npub>, nsite://<base36-pubkey><site>, or
  // nsite://v<base36-snapshot-id>.
  const parsed: ParsedNsiteSubdomain | null = parseNsiteSubdomain(host);
  if (!parsed) return undefined;

  if (parsed.kind === NSITE_SNAPSHOT_KIND) {
    return { kind: NSITE_SNAPSHOT_KIND, id: parsed.id, path };
  }
  if (parsed.kind === NSITE_ROOT_KIND) {
    return { kind: NSITE_ROOT_KIND, pubkey: parsed.pubkey, identifier: '', path };
  }
  return {
    kind: NSITE_NAMED_KIND,
    pubkey: parsed.pubkey,
    identifier: parsed.identifier,
    path,
  };
}

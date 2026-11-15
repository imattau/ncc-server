import type { SearchResult } from '@/lib/api';
import { useAuthor } from '@/hooks/useAuthor';
import { sanitizeHref } from '@/lib/sanitize';
import { Snippet } from '@/components/Snippet';

const KIND_LABEL: Record<SearchResult['kind'], string> = {
  'ncc-service': 'NCC service',
  'nsite-root': 'nsite',
  'nsite-named': 'nsite',
};

// A full npub/hex pubkey (~63/64 chars) is too long for a one-line
// breadcrumb -- noticed this rendering a demo result with no profile and no
// nip05, where the full npub pushed everything else off-screen.
function truncateIdentity(value: string) {
  return value.length > 24 ? `${value.slice(0, 16)}…${value.slice(-6)}` : value;
}

// Deterministic from the pubkey, not loaded from anywhere -- real search
// engines show a site favicon on this line; this is the equivalent for an
// identity that has no icon of its own, without calling out to a
// third-party favicon service (which would leak every search's targets to
// it) or waiting on a network fetch per result.
function hashHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

function IdentityMark({ seed, letter }: { seed: string; letter: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
      style={{ backgroundColor: `hsl(${hashHue(seed)} 55% 42%)` }}
    >
      {letter}
    </span>
  );
}

function StatusDot({ result }: { result: SearchResult }) {
  if (result.source === 'live') {
    return (
      <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-500">
        <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
        just found, unverified
      </span>
    );
  }
  if (result.lastStatus != null && result.lastStatus < 400) {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-500">
        <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
        reachable
      </span>
    );
  }
  if (result.lastStatus != null) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/50" aria-hidden="true" />
        unreachable
      </span>
    );
  }
  return null;
}

export function ResultRow({ result }: { result: SearchResult }) {
  const author = useAuthor(result.pubkey);
  const displayName = author.data?.metadata?.name?.trim();
  const rawIdentity = result.nip05 ?? displayName ?? result.npub ?? result.pubkey;
  const identity = truncateIdentity(rawIdentity);

  const href = sanitizeHref(result.endpoint);
  const title = result.title?.trim() || identity;
  const body = result.snippet || result.description || '';
  const status = <StatusDot result={result} />;

  return (
    <article className="max-w-2xl py-5 first:pt-0">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="block truncate text-lg text-blue-700 hover:underline visited:text-purple-700 dark:text-blue-400 dark:visited:text-purple-400"
        >
          {title}
        </a>
      ) : (
        <h3 className="truncate text-lg font-medium text-foreground">{title}</h3>
      )}

      {/* Breadcrumb/meta line, now under the title -- identity, kind, reachability. */}
      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-sm">
        <IdentityMark seed={result.pubkey} letter={identity.slice(0, 1).toUpperCase()} />
        <span className="truncate text-emerald-700 dark:text-emerald-400">{identity}</span>
        <span className="text-muted-foreground" aria-hidden="true">·</span>
        <span className="text-muted-foreground">{KIND_LABEL[result.kind]}</span>
        {status && (
          <>
            <span className="text-muted-foreground" aria-hidden="true">·</span>
            {status}
          </>
        )}
      </div>

      {body && (
        <p className="mt-1 text-sm leading-snug text-foreground/80">
          <Snippet text={body} />
        </p>
      )}
    </article>
  );
}

import type { ReactNode } from 'react';

// The backend's FTS5 snippet() wraps a match in plain "[" "]" markers, never
// HTML (see ncc-search/src/store.js's `snippet(services_fts, 5, '[', ']', …)`
// call) -- so this only ever splits on that literal delimiter and renders
// plain text nodes through JSX. It never uses dangerouslySetInnerHTML, even
// though the underlying text ultimately comes from relay-published event
// data that this app does not otherwise trust.

// A `nostr:npub1...`/`naddr1...`/etc reference embedded in a note's own body
// text (NIP-21) is only ever a few bytes of real data wrapped in a bech32
// encoding that reads as 60-120+ characters of noise -- rendering it raw
// blew out a result's whole snippet line with one unreadable token. This app
// has no profile/post page of its own to link to (it's a search index, not a
// client), so it truncates the same way identities already are elsewhere
// (see ResultRow.tsx's `truncateIdentity`) and links out to njump.me, a
// public read-only nostr viewer, rather than leaving a dead-end string.
const NOSTR_URI_RE = /nostr:(?:npub|nprofile|note|nevent|naddr)1[a-z0-9]+/g;

// The backend's FTS5 snippet() has a token budget (see store.js's `search`)
// and can run out of it partway through one of these references -- the
// leftover ("...full article. nostr…", or "...nostr:naddr1qpu…" if it gets
// further before cutting off) is never a complete, matchable URI, so
// without this it would render as raw, meaningless noise right at the end
// of the line. A half-finished reference conveys nothing a reader can act
// on, so it's dropped entirely rather than shown broken.
const DANGLING_NOSTR_PREFIX_RE = /nostr:?(?:npub|nprofile|note|nevent|naddr)?[a-z0-9]*…?$/i;

function stripDanglingNostrPrefix(text: string): string {
  const lastNostrIndex = text.lastIndexOf('nostr');
  if (lastNostrIndex === -1) return text;
  const tail = text.slice(lastNostrIndex);
  // A *complete* reference (nothing actually truncated) is left alone --
  // linkifyNostrUris below turns it into a real link as usual. Only an
  // incomplete prefix sitting at the very end of the string -- the exact
  // place snippet()'s own cutoff would leave one -- gets removed; "nostr"
  // appearing earlier in the text for some unrelated reason never matches
  // this because it requires being anchored to the string's end.
  if (new RegExp(`^nostr:(?:npub|nprofile|note|nevent|naddr)1[a-z0-9]+…?$`, 'i').test(tail)) {
    return text;
  }
  if (DANGLING_NOSTR_PREFIX_RE.test(tail)) {
    return text.slice(0, lastNostrIndex).trimEnd();
  }
  return text;
}

function truncateNostrUri(uri: string): string {
  return uri.length > 24 ? `${uri.slice(0, 16)}…${uri.slice(-6)}` : uri;
}

function linkifyNostrUris(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let n = 0;
  NOSTR_URI_RE.lastIndex = 0;
  while ((match = NOSTR_URI_RE.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const uri = match[0];
    // Only lowercase bech32 characters ever reach this point (the regex
    // above admits nothing else), so the identifier portion can't carry
    // anything that would make this URL do something other than what it
    // looks like -- no separate sanitizeHref call needed here.
    nodes.push(
      <a
        key={`${keyPrefix}-${n++}`}
        href={`https://njump.me/${uri.slice('nostr:'.length)}`}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-blue-700 hover:underline visited:text-purple-700 dark:text-blue-400 dark:visited:text-purple-400"
      >
        {truncateNostrUri(uri)}
      </a>,
    );
    lastIndex = match.index + uri.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export function Snippet({ text }: { text: string }) {
  const parts = stripDanglingNostrPrefix(text).split(/\[([^\]]*)\]/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-yellow-200 px-0.5 text-inherit [overflow-wrap:anywhere] dark:bg-yellow-500/40">
            {linkifyNostrUris(part, `m${i}`)}
          </mark>
        ) : (
          linkifyNostrUris(part, `p${i}`)
        ),
      )}
    </>
  );
}

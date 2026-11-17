import { type NostrEvent } from '@nostrify/nostrify';

import { NOSTR_URI_RE, type NoteReference } from '@/lib/nostrReferences';

// A quoted note shows enough of the referenced event to decide whether to
// open it: who wrote it, when, and the opening of the text. The rest stays on
// njump, which is also where the reference pointed before it was inlined.
const EXCERPT_LIMIT = 280;

const KIND_LABEL: Record<number, string> = {
  1: 'note',
  11: 'thread',
  20: 'picture',
  21: 'video',
  22: 'short video',
  1111: 'comment',
  30023: 'article',
  30024: 'draft',
};

/**
 * Flatten an event body to one line of plain text. The card is a quote, not a
 * second article: Markdown that the outer renderer already understood is
 * noise here, and a referenced event's own `nostr:` references would only
 * repeat the raw bech32 the card exists to hide. The event's text is rendered
 * as a text node, never re-parsed as Markdown, so quoting cannot recurse.
 */
function plainExcerpt(content: string) {
  const text = content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(NOSTR_URI_RE, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`*_>#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= EXCERPT_LIMIT) return text;
  // Cut at a word boundary when one is anywhere near the limit, so the card
  // does not end mid-word; a single enormous token still gets cut.
  const cut = text.slice(0, EXCERPT_LIMIT);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > EXCERPT_LIMIT * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function formatDate(seconds: number) {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Spans with block-level display, not a `<figure>`/`<div>`: a reference can
// sit inside a paragraph (`see nostr:nevent…`) or a list item, and a block
// element there would be invalid markup inside a `<p>`. React builds the DOM
// directly, but nesting still shows up in accessibility trees and DOM
// snapshots, so the card stays phrasing content and only its layout is block.
const FRAME = 'my-2 grid w-full max-w-full gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm';

export function QuotedNote({
  reference,
  event,
  author,
}: {
  reference: NoteReference;
  event?: NostrEvent;
  author?: string;
}) {
  const href = `https://njump.me/${reference.bech32}`;

  // Before the lookup answers there is no event yet. The caller only renders
  // this branch while the lookup is running; a note that never arrives is
  // shown as the plain shortened reference instead of an empty card.
  if (!event) {
    return (
      <span className={`${FRAME} text-muted-foreground`} aria-busy="true" title={reference.uri}>
        Quoted note…
      </span>
    );
  }

  const title = event.tags.find((tag) => tag[0] === 'title' && tag[1])?.[1];
  const excerpt = plainExcerpt(event.content);
  const kindLabel = event.kind === 1 ? null : (KIND_LABEL[event.kind] ?? `kind ${event.kind}`);

  return (
    <span className={FRAME} title={reference.uri}>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        {author && <span className="font-medium text-foreground">{author}</span>}
        {author && <span aria-hidden="true">·</span>}
        <time dateTime={new Date(event.created_at * 1000).toISOString()}>{formatDate(event.created_at)}</time>
        {kindLabel && (
          <>
            <span aria-hidden="true">·</span>
            <span>{kindLabel}</span>
          </>
        )}
      </span>

      {title && <span className="line-clamp-2 font-medium text-foreground">{title}</span>}
      {excerpt ? (
        <span className="line-clamp-4 leading-relaxed text-foreground/80">{excerpt}</span>
      ) : (
        !title && <span className="text-muted-foreground italic">This note has no text.</span>
      )}

      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="justify-self-end text-xs text-blue-700 underline-offset-2 hover:underline dark:text-blue-400"
      >
        Open on njump
      </a>
    </span>
  );
}

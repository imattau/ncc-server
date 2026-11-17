import { type NostrEvent } from '@nostrify/nostrify';

import { NOSTR_URI_RE, type NoteReference } from '@/lib/nostrReferences';
import { sanitizeHref } from '@/lib/sanitize';

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

// A quoted note's images are part of what it says, so the card shows them --
// but as the browser loading the author's URLs directly, exactly like the
// article body does (see ArticleMarkdown's `img` renderer): nothing here is
// proxied, and `loading="lazy"` means only the cards scrolled into view fetch
// anything. Four is enough to know what the note is; beyond that it is a
// gallery, and the note is one click away.
const MAX_QUOTE_IMAGES = 4;
const IMAGE_URL_RE = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i;

function imageUrls(event: NostrEvent): string[] {
  const urls = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (!value) return;
    const safe = sanitizeHref(value.trim());
    if (safe) urls.add(safe);
  };

  const eventMime = event.tags.find((tag) => tag[0] === 'm')?.[1]?.toLowerCase() ?? null;
  for (const tag of event.tags) {
    // NIP-92: one `imeta` tag per attachment, each a list of `key value`
    // strings. Only entries the tag itself says are images qualify -- an
    // `imeta` with `m video/mp4` must not render a still frame here.
    if (tag[0] === 'imeta') {
      const url = tag.find((value) => value.startsWith('url '))?.slice('url '.length);
      const mime = tag.find((value) => value.startsWith('m '))?.slice(2).trim().toLowerCase();
      if (url && (!mime || mime.startsWith('image/'))) add(url);
      continue;
    }
    // NIP-23 cover image, NIP-94 `url` (only when the event says image), and
    // the NIP-68/71 picture kinds' plain `url`.
    if (tag[0] === 'image') add(tag[1]);
    if (tag[0] === 'url' && (!eventMime || eventMime.startsWith('image/'))) add(tag[1]);
  }

  // Markdown images (`![alt](url)`) and bare image URLs in the text. Only
  // http(s) URLs with an image extension survive: a note that links to a
  // page is a link, not an image.
  for (const match of event.content.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) add(match[1]);
  for (const match of event.content.matchAll(/https?:\/\/[^\s<>()]+/g)) {
    const url = match[0].replace(/[.,;:!?]+$/, '');
    if (IMAGE_URL_RE.test(url)) add(url);
  }

  return [...urls].slice(0, MAX_QUOTE_IMAGES);
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
  const images = imageUrls(event);
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
      {excerpt && <span className="line-clamp-4 leading-relaxed text-foreground/80">{excerpt}</span>}

      {images.length > 0 && (
        <span className="mt-0.5 flex flex-wrap gap-1.5">
          {images.map((src) => (
            <img
              key={src}
              src={src}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="max-h-44 max-w-full rounded-sm border border-border object-contain"
            />
          ))}
        </span>
      )}

      {!title && !excerpt && images.length === 0 && (
        <span className="text-muted-foreground italic">This note has no text.</span>
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

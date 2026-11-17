import { useMemo, type ReactNode } from 'react';
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useMentionProfiles } from '@/hooks/useMentionProfiles';
import { truncateIdentity } from '@/lib/identity';
import {
  NOSTR_URI_EXACT_RE,
  NOSTR_URI_RE,
  NOSTR_URI_TEST_RE,
  type NostrReference,
  parseNostrReference,
} from '@/lib/nostrReferences';
import { sanitizeHref } from '@/lib/sanitize';

// NIP-23 content is Markdown written by the article's author, fetched
// straight from a relay. react-markdown renders it to React elements, never
// HTML: no raw-HTML plugin is enabled, so a `<script>` or an inline handler in
// the source renders as literal text. URLs still go through react-markdown's
// own allowlist transform (`defaultUrlTransform`, which drops `javascript:`
// and friends), with one addition: `nostr:` references are passed through
// untouched so the `a` renderer can turn them into a readable mention (see
// `NostrMention`) instead of a 63-character bech32 blob. The emitted href is
// always a public njump.me URL, never `nostr:` itself.
function articleUrlTransform(url: string): string {
  if (NOSTR_URI_EXACT_RE.test(url)) return url;
  return defaultUrlTransform(url);
}

const LINK_CLASS =
  'text-blue-700 underline underline-offset-2 visited:text-purple-700 dark:text-blue-400 dark:visited:text-purple-400';

// Minimal mdast shapes -- the plugin only needs to walk children and rewrite
// text nodes, and react-markdown owns the real parser types.
type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
};

function splitNostrReferences(value: string): MdNode[] {
  const nodes: MdNode[] = [];
  let lastIndex = 0;
  NOSTR_URI_RE.lastIndex = 0;
  for (const match of value.matchAll(NOSTR_URI_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push({ type: 'text', value: value.slice(lastIndex, index) });
    // The visible text is the URI itself; `NostrMention` replaces it with a
    // name at render time (or shortens it when no name is available).
    nodes.push({
      type: 'link',
      url: match[0],
      children: [{ type: 'text', value: match[0] }],
    });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < value.length) nodes.push({ type: 'text', value: value.slice(lastIndex) });
  return nodes;
}

function linkifyNostrUris(node: MdNode) {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    // A bare reference in running text becomes a link. Anything already
    // inside a link keeps the author's own label, and code spans are left
    // alone -- `nostr:...` there is literal, not a mention.
    if (
      child.type === 'text' &&
      node.type !== 'link' &&
      typeof child.value === 'string' &&
      NOSTR_URI_TEST_RE.test(child.value)
    ) {
      next.push(...splitNostrReferences(child.value));
      continue;
    }
    if (
      child.type !== 'link' &&
      child.type !== 'linkReference' &&
      child.type !== 'inlineCode' &&
      child.type !== 'code'
    ) {
      linkifyNostrUris(child);
    }
    next.push(child);
  }
  node.children = next;
}

function remarkNostrMentions() {
  return (tree: unknown) => {
    linkifyNostrUris(tree as MdNode);
  };
}

function flattenText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(flattenText).join('');
  return '';
}

function mentionLabel(reference: NostrReference, names: ReadonlyMap<string, string>): string {
  if (reference.kind === 'profile') {
    const name = names.get(reference.pubkey);
    if (!name) return `@${truncateIdentity(reference.bech32)}`;
    // A nip05 fallback already reads as `user@domain`; prefixing it with
    // another `@` would turn it into nonsense.
    return name.includes('@') ? name : `@${name}`;
  }
  return truncateIdentity(reference.bech32);
}

// A `nostr:` mention rendered as text the reader can act on: the profile's
// name when one is known, a shortened npub when it isn't. The link target is
// always njump.me -- this app is a search index, not a Nostr client, so there
// is no local profile/post page to open. `overflow-wrap:anywhere` matters
// even for a fallback: in a narrow preview a 24-character token with no
// spaces must break inside the column, not push the sheet sideways.
function NostrMention({
  reference,
  names,
  children,
}: {
  reference: NostrReference;
  names: ReadonlyMap<string, string>;
  children: ReactNode;
}) {
  const childText = flattenText(children).trim();
  // Keep the author's wording when they linked a mention under custom text
  // (e.g. `[my friend](nostr:npub...)`); only substitute a name when the
  // "label" is the raw reference itself.
  const customLabel = childText.length > 0 && !childText.toLowerCase().startsWith('nostr:');

  return (
    <a
      href={`https://njump.me/${reference.bech32}`}
      target="_blank"
      rel="noopener noreferrer nofollow"
      title={reference.uri}
      className={`${LINK_CLASS} [overflow-wrap:anywhere]`}
    >
      {customLabel ? children : mentionLabel(reference, names)}
    </a>
  );
}

// Utility classes rather than a prose/typography plugin: this is the only
// place in the app that renders arbitrary author formatting, and a handful of
// explicit element styles is smaller and more predictable than a plugin's
// global cascade.
function createComponents(names: ReadonlyMap<string, string>): Components {
  return {
    a: ({ href, children }) => {
      const reference = parseNostrReference(href);
      if (reference) {
        return (
          <NostrMention reference={reference} names={names}>
            {children}
          </NostrMention>
        );
      }
      // A `nostr:` URL that matched the shape but did not decode is not a
      // reference; show the author's text rather than emitting a dead link.
      if (href?.toLowerCase().startsWith('nostr:')) return <>{children}</>;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={LINK_CLASS}>
          {children}
        </a>
      );
    },
    // Article images are loaded by the reader's browser from wherever the
    // author hosts them -- never proxied through ncc-search, which does not
    // touch media bytes at all. `no-referrer` keeps the visit from announcing
    // the search page to that host; a non-http(s) source is dropped.
    img: ({ src, alt }) => {
      const safe = sanitizeHref(src);
      if (!safe) return null;
      return (
        <img
          src={safe}
          alt={alt ?? ''}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="my-4 max-h-96 max-w-full rounded-md border border-border object-contain"
        />
      );
    },
    h1: ({ children }) => <h2 className="mt-6 mb-2 text-xl font-semibold text-foreground">{children}</h2>,
    h2: ({ children }) => <h3 className="mt-6 mb-2 text-lg font-semibold text-foreground">{children}</h3>,
    h3: ({ children }) => <h4 className="mt-5 mb-2 text-base font-semibold text-foreground">{children}</h4>,
    h4: ({ children }) => <h5 className="mt-4 mb-2 text-sm font-semibold text-foreground">{children}</h5>,
    p: ({ children }) => <p className="my-3 leading-relaxed text-foreground/90">{children}</p>,
    ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6 text-foreground/90">{children}</ul>,
    ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6 text-foreground/90">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-4 border-l-2 border-border pl-4 text-foreground/80 italic">{children}</blockquote>
    ),
    hr: () => <hr className="my-6 border-border" />,
    // Inline `code` is styled here; a fenced block gets the same element nested
    // in `pre`, so `pre` resets its child's background/padding to avoid a
    // "box inside a box".
    code: ({ children }) => (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
    ),
    pre: ({ children }) => (
      <pre className="my-4 overflow-x-auto rounded-md border border-border bg-muted/60 p-3 text-xs leading-relaxed [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    th: ({ children, style }) => (
      <th style={style} className="border border-border px-2 py-1 text-left font-semibold">
        {children}
      </th>
    ),
    td: ({ children, style }) => (
      <td style={style} className="border border-border px-2 py-1 align-top">
        {children}
      </td>
    ),
  };
}

const NO_NAMES: ReadonlyMap<string, string> = new Map();

export function ArticleMarkdown({ content }: { content: string }) {
  const profiles = useMentionProfiles(content);
  const names = profiles.data ?? NO_NAMES;
  // The components object closes over the resolved names, so it has to be
  // rebuilt when (and only when) they arrive.
  const components = useMemo(() => createComponents(names), [names]);

  return (
    <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkNostrMentions, remarkGfm]}
        urlTransform={articleUrlTransform}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

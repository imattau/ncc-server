import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { sanitizeHref } from '@/lib/sanitize';

// NIP-23 content is Markdown written by the article's author, fetched
// straight from a relay. react-markdown renders it to React elements, never
// HTML: no raw-HTML plugin is enabled, so a `<script>` or an inline handler in
// the source renders as literal text. URLs still go through react-markdown's
// own allowlist transform (`defaultUrlTransform`, which drops `javascript:`
// and friends), with one addition: `nostr:` references are rewritten to a
// public viewer so a mention is clickable instead of being silently stripped.
// Same destination Snippet.tsx already uses for references in indexed text.
const NOSTR_REFERENCE_RE = /^nostr:(?:npub|nprofile|note|nevent|naddr)1[a-z0-9]+$/i;

function articleUrlTransform(url: string): string {
  if (NOSTR_REFERENCE_RE.test(url)) {
    return `https://njump.me/${url.slice('nostr:'.length)}`;
  }
  return defaultUrlTransform(url);
}

const LINK_CLASS =
  'text-blue-700 underline underline-offset-2 visited:text-purple-700 dark:text-blue-400 dark:visited:text-purple-400';

// Utility classes rather than a prose/typography plugin: this is the only
// place in the app that renders arbitrary author formatting, and a handful of
// explicit element styles is smaller and more predictable than a plugin's
// global cascade.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={LINK_CLASS}>
      {children}
    </a>
  ),
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

export function ArticleMarkdown({ content }: { content: string }) {
  return (
    <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={articleUrlTransform}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

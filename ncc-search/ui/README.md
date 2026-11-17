# ncc-search UI

A search-engine-style results page (compact header + pill search box +
plain SERP list, not a card grid or chat-style layout) for the `ncc-search`
backend. React+Vite+TypeScript+Tailwind, based on the same
[MKStack](https://soapbox.pub/tools/mkstack) scaffold and core stack as this
repo's [`test-app/`](../../test-app). This focused UI keeps only the
shadcn-style primitives it uses (`Button`, `Input`, and `Skeleton`) and has
no routing library. Login is NIP-07-only rather than `test-app`'s full
nsec/bunker/extension-chooser `LoginArea`, since this app never publishes
anything -- see "Personalization" below. The generic shadcn card/badge/
button kit was tried first and dropped in favor of a plain list layout that
actually reads like a search engine result.

## Division of labour

- **`ncc-search` backend** (`../src`) owns the crawl, the anchored NCC-02/
  NCC-05 resolution, the nsite (NIP-5A) adapter, the NIP-23/68/71 article and
  media adapters, NIP-05 verification, and the SQLite/FTS5 full-text index.
  It exposes `GET /search?q=` as plain JSON — see
  [`../src/server.js`](../src/server.js). Results carry a `kind` field
  (`ncc-service` / `nsite-root` / `nsite-named` / `article` / `image` /
  `video`), a `source` field (`index` = verified/discovered by the crawler,
  `live` = a just-found NIP-50 hit, not yet even discovered), and, when
  verified, a `nip05` handle.
- **This UI** is a thin client over that endpoint, plus two pieces of
  client-side work the backend deliberately doesn't do:
    - [`src/hooks/useAuthor.ts`](src/hooks/useAuthor.ts) resolves a result's
      `kind:0` profile for display only (a name instead of a bare npub), via
      [Nostrify](https://nostrify.dev/) (`src/lib/nostrPool.ts` — a minimal,
      read-only, no-login `NPool`, not `test-app`'s full `NostrProvider`,
      since this page never publishes). `nip05`, when the backend already
      verified it, always takes priority over this display-only lookup — see
      `ResultRow.tsx`.
    - For `image`/`video` results, the browser fetches and renders the media
      directly from its original host — `ResultRow.tsx` renders a real
      `<img>`/`<video>` with the backend-supplied `mediaUrl`, never proxied
      through the backend (which never touches media bytes at all, see
      `../src/adapters/media.js`). Reachability is checked client-side too,
      off the main thread, by
      [`src/workers/mediaProbe.worker.ts`](src/workers/mediaProbe.worker.ts)
      via [`src/hooks/useMediaProbe.ts`](src/hooks/useMediaProbe.ts) — the
      "worker thread" role the backend's own `lastStatus` check plays for
      ncc-service/nsite rows, just run in the browser instead, since there's
      nothing for the backend to check server-side here.
    - Images specifically get two more layers, both because the backend
      can't shrink what the origin server sends (no resize proxy here by
      design): [`useBlurhashPlaceholder`](src/hooks/useBlurhashPlaceholder.ts)
      decodes a NIP-68/71 `blurhash` on the main thread (a handful of
      pixels — too cheap to bother with a worker) for an instant preview,
      and [`imageResize.worker.ts`](src/workers/imageResize.worker.ts) +
      [`useResizedImage`](src/hooks/useResizedImage.ts) fetch, decode and
      downscale the real image off the main thread into a smaller re-encoded
      WebP, replacing the placeholder once ready. If the host doesn't allow
      a cross-origin read (no CORS headers — common, not universal) or
      anything else in that pipeline fails, `ResultRow.tsx` falls back to
      the plain `<img src={mediaUrl}>` this project started with — the
      optimization is additive, never a requirement to view a result.
    - For `article` results, the full NIP-23 body is fetched **from the
      relays by the browser** when a reader clicks "Preview article", then
      rendered as Markdown in a dialog — see "Article previews" below. The
      results page itself loads no article bodies.

## Landing tagline

The landing page quotes the index's current `recordCount` from `/status` in a
short, rotating tagline ("Serving 248,633 records. Still fewer than your open
tabs."). One line is chosen per page load, so the count can refresh without the
sentence changing underneath the reader; while `/status` is in flight the line
says "Counting the index…", and if the count is genuinely zero it says so
instead of inventing a number. The status query is the same one the results
page's health notice uses, so it is cached and shared.

## Article previews

An indexed `article` result carries a title, summary, cover and a
truncated plain-text snippet. That is enough to rank and label a result,
but not enough to read one: the backend stores an FTS-friendly stripped
copy and `/search` only returns the snippet, never the body. So the
preview is built from the article event itself, in the browser:

- The "Preview article" link on an article row opens
  [`ArticlePreviewDialog`](src/components/ArticlePreviewDialog.tsx). Only
  then does [`useArticleEvent`](src/hooks/useArticleEvent.ts) run its
  `{ kinds: [30023], authors: [pubkey], '#d': [itemId] }` query against the
  same relay list `useAuthor` uses. The query is `enabled: false` while
  the dialog is closed, so rendering a results page never fires one relay
  query per article row.
- [`ArticleMarkdown`](src/components/ArticleMarkdown.tsx) renders it with
  react-markdown + remark-gfm and **no raw-HTML plugin**, so author HTML is
  always escaped rather than injected. URLs go through react-markdown's
  own allowlist transform, plus one rewrite: `nostr:` references become
  njump.me links, matching `Snippet.tsx`. Body images are fetched by the
  reader's browser from the author's host with `referrerPolicy="no-referrer"`
  — nothing here is proxied through ncc-server.
- The Markdown renderer is code-split with `lazy()`: react-markdown and the
  unified parser stack are ~50 kB gzipped, for a dialog most sessions never
  open, so they are fetched on the first preview rather than on page load.
- The dialog is a native `<dialog>` — a centered panel at `sm` and above,
  and a full-height sheet below it, because long-form text doesn't fit
  readably in a short card on a phone. Escape, backdrop click, background
  inertness and focus restoration come from the element itself; the body
  scroll lock is explicit because some mobile browsers still scroll the
  page behind a modal.
- If the relays don't return the event, the dialog keeps the indexed
  title/summary/cover, shows the indexed excerpt, and offers "Try again"
  and an "Open in njump" link built from the article's `naddr`.

## Resized-image cache: LRU, memory-bounded

[`useResizedImage`](src/hooks/useResizedImage.ts) caches resized images by
URL at module scope so switching filter tabs or re-rendering never
re-fetches/re-resizes one this page already processed — but each cached
entry is a live decoded image held via a `blob:` object URL for as long as
it stays cached, so left unbounded this could grow for the whole lifetime
of a long scrolling/searching session. Capped by total bytes (the resize
worker reports each blob's real size, not a row count, since image sizes
vary a lot — see `imageResize.worker.ts`'s `ResizeResult.byteSize`), default
150MB, configurable via `VITE_NCC_SEARCH_IMAGE_CACHE_MAX_BYTES` (see
`.env.example`) — an operator/build-time setting, same convention as
`VITE_NCC_SEARCH_API_BASE`, since this app has no settings surface for an
end user to turn a dial on themselves.

Eviction is LRU or nothing: the least-recently-*read* entry is dropped
first (tracked by a `Map`'s insertion order, re-touched on every cache
hit — a plain, dependency-free LRU), but only among entries nothing is
currently displaying. Revoking a `blobUrl` still mounted in an `<img>`
would break that image with no retry path, since nothing re-triggers the
resize fetch on eviction alone — only the URL changing does. So the budget
can be temporarily exceeded while everything currently on screen genuinely
needs to stay in memory; that's the correct tradeoff over breaking a
visible image to satisfy a byte count.

This is purely an in-memory bound, not a literal disk cache — the browser's
own HTTP cache (`cache: 'force-cache'` on the worker's `fetch`, for the
*original* un-resized bytes) is a separate layer with its own disk-backed
eviction policy that this app doesn't control and has no setting for.

## Personalization (NIP-07 sign-in)

Signing in identifies which pubkey's follows/interests should re-rank
results — it is not a login *session* the way `test-app`'s `LoginArea` is.
[`useNip07Login`](src/hooks/useNip07Login.ts) calls only
`window.nostr.getPublicKey()` — never `signEvent` — the narrowest permission
an extension can grant, since this app never publishes anything. The pubkey
(public data) persists in `localStorage` so a reload doesn't force
re-signing-in.

Once signed in:
- [`useFollows`](src/hooks/useFollows.ts) reads the user's NIP-02 contact
  list (`kind:3`) for a follow-boost.
- [`useInterests`](src/hooks/useInterests.ts) reads their NIP-51 interest
  list (`kind:10015`) if they have one, unioned with the most-used hashtags
  across their own recent notes (`kind:1`) as a fallback — most accounts
  don't have a populated `kind:10015` list today, but do have hashtagged
  notes. Doesn't follow `kind:10015`'s `a`-tag references to named
  `kind:30015` sets; a real NIP-51 feature, skipped for now as another
  relay round-trip for a signal few users have populated anyway.
- [`lib/ranking.ts`](src/lib/ranking.ts) boosts followed authors above
  hashtag-interest matches above everything else, stably — ties keep the
  backend's own relevance order rather than whatever `Array.prototype.sort`
  would otherwise leave them in. `SearchPage.tsx` also requests more results
  (`PERSONALIZED_LIMIT = 50` instead of the default 20) when signed in, so
  there's something beyond the first page to actually re-rank.
- This backend computes none of this itself — it only exposes `hashtags`
  per result (NIP-23/68/71 `t` tags; null for ncc-service/nsite, which have
  no hashtag concept) for the UI to match against.

**Bug caught live while verifying this**: `LoginButton` originally called
`useNip07Login()` itself, and it's rendered in two places (landing view +
compact header). Two hook instances means two independent `useState`s —
signing out via one updated that button correctly but left `SearchPage`'s
own `pubkey` (the one actually driving `useFollows`/`useInterests`) stale,
confirmed by a personalization notice that kept reading "Signed in" after
the header had already flipped back to "Sign in". Fixed by lifting the one
`useNip07Login()` call to `SearchPage` and making `LoginButton` a controlled
component (`pubkey`/`onSignIn`/`onSignOut` props) — verified by signing in
and out with a mocked `window.nostr` and confirming both places update
together on every transition, not just after a reload happens to
resynchronize them from `localStorage`.

## Safe search

[`useSafeSearch`](src/hooks/useSafeSearch.ts) is a client-side display
preference, on by default (same convention every real search engine uses —
absence of a stored choice means "on", not "off"), persisted in
`localStorage`. It filters out any result carrying a NIP-68/71
`content-warning` tag — see `contentWarning` on `SearchResult`
(`src/lib/api.ts`) and the backend's `resolveMedia` (`../README.md`). This
app makes no safety judgment of its own: it only trusts what the publisher
tagged, same as the backend. `SearchPage.tsx` shows a "N hidden by safe
search" note (clickable to toggle) whenever results are actually being
hidden, so turning it on never looks like those results simply don't exist.
With it off, flagged results show instead with a visible label (the tag's
own text, e.g. "nsfw") on `ResultRow`/`MediaGridCard` rather than silently
blending in.

## Appearance (light/dark mode)

[`useTheme`](src/hooks/useTheme.ts) toggles Tailwind's class-based dark
variant (`@custom-variant dark (&:is(.dark *));` in `src/index.css`) by
adding/removing a `dark` class on `<html>`. Found live that this variant was
already fully defined in CSS but nothing in the app ever activated it or
looked at the OS theme — the app was permanently light-mode regardless of
system preference until this hook existed. Defaults to the OS preference
(`prefers-color-scheme`), explicit choice persisted in `localStorage` and
then takes precedence over any later OS-level change; uses `useLayoutEffect`
rather than `useEffect` specifically to apply the theme class before first
paint, avoiding a flash of the wrong theme on load for anyone whose stored
or system preference is dark.

## Accessibility

Caught live, not from a checklist: `SearchBar`'s pill used `border-border`
(`hsl(214.3 31.8% 91.4%)`), which is barely distinguishable from a white
page background — well under WCAG 1.4.11's 3:1 minimum for UI component
boundaries. Switched to `border-muted-foreground` (full opacity, ~4.85:1
against white), with `focus-within:border-foreground` added as a visible
focus state, since the `<input>` itself sets `outline-none` with nothing
else to replace it (WCAG 2.4.7). Also added an explicit `aria-label` to
`LoginButton`'s signed-in state (previously only a `title`, which isn't
reliably exposed to screen readers) — `IdentityMark`'s decorative avatar
letter already had `aria-hidden="true"`.

## Running it

```bash
cd ncc-search/ui
cp .env.example .env   # point VITE_NCC_SEARCH_API_BASE at the backend
npm install
npm run dev
```

The backend must have CORS enabled for this to work from a browser at a
different origin/port — it is by default (`NCC_SEARCH_CORS_ORIGIN` unset
reflects any origin; see `../.env.example`). This was caught live while
first wiring the two together: the backend returned correct JSON over curl
but the browser's `fetch` failed silently with no CORS headers set.

`npm run build` type-checks (`tsc --noEmit`) then builds to `dist/`. Not
wired into Caddy yet — see the root README's "Quick start" for how
`test-app/` is built into `public/`; this UI is deliberately kept as its own
build output for now rather than assuming it shares the main site's route.

## What's implemented vs. not

Done: the search page itself (landing view, results list, loading/error/
empty states, URL-synced query via `?q=`, filter tabs with live counts,
snippet match highlighting, NIP-21 `nostr:` URI truncation + linking to
njump.me within a result's body text (see `src/components/Snippet.tsx`;
this app has no profile/post page of its own to link to instead),
`sanitizeHref`-gated result links/media src — see `src/lib/sanitize.ts`),
profile display names via Nostrify, and
client-side image/video rendering + reachability probing (see above), safe
search (see above), light/dark mode (see above), on-demand article previews
rendered from the relay event (see above), a landing-page tagline that quotes
the live index size from `/status` and picks one of several lines per load
(see above), and a memory-bounded LRU cache for resized images (see above).

Three CSP gaps worth knowing if `index.html`'s policy is ever rewritten from
scratch — each was caught live by something going silently blank with no
error visible except in the console, not by reading the spec:
- `media-src` must be set explicitly for `<video>` to load at all — `<img>`
  happens to keep working via `img-src` alone without it.
- `worker-src` needs `'self' blob:`, not just `'self'`: Vite's **dev server**
  bootstraps a module worker via `new Worker(URL.createObjectURL(...))`, a
  `blob:` URL. Without this, `mediaProbe.worker.ts`/`imageResize.worker.ts`
  fail to construct at all in dev — and because the failure is a worker
  constructor throwing, not a rejected fetch, every image/video result got
  stuck on "checking…" forever with no obviously-related console error.
  (Production builds emit a same-origin file and don't strictly need this,
  but keeping it costs nothing meaningful security-wise.)
- `img-src` needs `blob:` too, for a different reason: `useResizedImage`'s
  worker hands back a re-encoded image as a `Blob`, rendered via
  `URL.createObjectURL(blob)`. Without `blob:` here, a perfectly valid,
  correctly fetched-and-resized image still renders as a broken-image icon.
  Verified this one by hand — pulled the blob's raw bytes and confirmed a
  genuine `RIFF....WEBP` signature before finding the CSP violation in the
  console was the actual cause, not the encoding.

Not yet: a "re-check now" action that re-runs resolution live in the
browser against the user's own relay set rather than trusting only the
backend's last crawl. `NOSTR_RELAYS` in `src/lib/nostrPool.ts` already holds
the relay list this would query; the resolution logic itself would need to
be ported or shared from the backend's `src/resolver.js` /
`src/adapters/nsite.js` to avoid re-implementing the anchor/locator/
integrity checks differently on the client.

# ncc-search UI

A search-engine-style results page (compact header + pill search box +
plain SERP list, not a card grid or chat-style layout) for the `ncc-search`
backend. React+Vite+TypeScript+Tailwind, in the spirit of
[MKStack](https://soapbox.pub/tools/mkstack) — same core stack as this
repo's [`test-app/`](../../test-app) — but trimmed down from the full
MKStack template: no login, no routing library, no shadcn/ui kit beyond a
`Skeleton` component, since a one-page, read-only search UI doesn't need
publish/auth machinery or a polymorphic component library. The generic
shadcn card/badge/button kit was tried first and dropped in favor of a
plain list layout that actually reads like a search engine result.

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
snippet match highlighting, `sanitizeHref`-gated result links/media src —
see `src/lib/sanitize.ts`), profile display names via Nostrify, and
client-side image/video rendering + reachability probing (see above).

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

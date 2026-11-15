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
  NCC-05 resolution, the nsite (NIP-5A) adapter, NIP-05 verification, and the
  SQLite/FTS5 full-text index. It exposes `GET /search?q=` as plain JSON —
  see [`../src/server.js`](../src/server.js). Results carry a `kind` field
  (`ncc-service` / `nsite-root` / `nsite-named`), a `source` field
  (`index` = verified by the crawler, `live` = a just-found NIP-50 hit, not
  yet verified), and, when verified, a `nip05` handle.
- **This UI** is a thin client over that endpoint, plus one piece of
  client-side Nostr: [`src/hooks/useAuthor.ts`](src/hooks/useAuthor.ts)
  resolves a result's `kind:0` profile for display only (a name instead of a
  bare npub), via [Nostrify](https://nostrify.dev/)
  (`src/lib/nostrPool.ts` — a minimal, read-only, no-login `NPool`, not
  `test-app`'s full `NostrProvider`, since this page never publishes).
  `nip05`, when the backend already verified it, always takes priority over
  this display-only lookup — see `ResultRow.tsx`.

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
empty states, URL-synced query via `?q=`, snippet match highlighting,
`sanitizeHref`-gated result links — see `src/lib/sanitize.ts`), profile
display names via Nostrify.

Not yet: a "re-check now" action that re-runs resolution live in the
browser against the user's own relay set rather than trusting only the
backend's last crawl. `NOSTR_RELAYS` in `src/lib/nostrPool.ts` already holds
the relay list this would query; the resolution logic itself would need to
be ported or shared from the backend's `src/resolver.js` /
`src/adapters/nsite.js` to avoid re-implementing the anchor/locator/
integrity checks differently on the client.

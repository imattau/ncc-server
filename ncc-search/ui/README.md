# ncc-search UI (not yet scaffolded)

This directory is reserved for the search page frontend. Plan is to generate
it from [MKStack](https://soapbox.pub/tools/mkstack) — the same
React+Vite+TypeScript+Tailwind+shadcn/ui+[Nostrify](https://nostrify.dev/)
template this repo's own [`test-app/`](../../test-app) is built from — rather
than hand-rolling a page, for consistency with the rest of this project.

Division of labour:

- **`ncc-search` backend** (`../src`) owns the crawl, the anchored NCC-02/
  NCC-05 resolution, the nsite (NIP-5A) adapter, NIP-05 verification, and the
  SQLite/FTS5 full-text index. It exposes `GET /search?q=` as plain JSON — see
  [`../src/server.js`](../src/server.js). Results carry a `kind` field
  (`ncc-service` / `nsite-root` / `nsite-named`) and, when verified, a
  `nip05` handle — the UI should badge these rather than treat every result
  as the same shape.
- **This UI** is a thin client: it calls that `/search` endpoint for results.
  Nostrify is relevant here, not for full-text search (relays don't do that —
  see the research notes in the parent conversation on NIP-50's thin support),
  but for optional client-side extras that *do* belong on the relay side:
    - resolving a result's own profile (`kind:0`) for display, so results show
      a name/avatar instead of a bare npub -- note the backend already
      verifies `nip05` server-side (see `src/adapters/nsite.js`); the UI
      should trust that field rather than re-deriving it, and only use its
      own `kind:0` lookup for the avatar/display name.
    - a "re-check now" action per result that re-runs resolution live in the
      browser against the user's own relay set, rather than trusting only the
      backend's last crawl.

## Scaffolding steps (when ready to build this)

1. Generate a new MKStack project here (per the Stacks CLI / template clone
   flow on soapbox.pub/tools/mkstack).
2. Point its data fetching at this backend's `/search` endpoint — proxy it
   through Caddy on a path alongside the rest of this repo's services rather
   than exposing `ncc-search`'s port directly.
3. Keep Nostrify's relay pool configured with the same relay list as
   `NCC_SEARCH_RELAYS` (`../.env.example`), so "re-check now" queries the same
   relays the backend crawls.
4. Build output goes to `public/` the same way `test-app/` does for the main
   site (see repo root README's "Quick start"), or to its own Caddy route if
   it should be served separately from the primary site.

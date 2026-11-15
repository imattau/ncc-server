# ncc-search

A separate, standalone process that discovers public Nostr-native content —
NCC-02/NCC-05 service records, nsites (NIP-5A), NIP-23 articles, and NIP-68/71
pictures and videos — resolves each per its own normative contract, and
serves unified full-text search over the result.

This is not a feature of `ncc-server` or the `ncc-sidecar`: it runs as its own
process/service (`ncc-search.service`), reads from the same relay list, and
is intended to sit behind Caddy on its own path, same pattern as every other
service in this repo.

## Why it fetches sites instead of just indexing relay metadata

A plain relay-metadata index (service name, npub, endpoint host) is cheap but
not very useful for search — it's closer to a phone book than a search
engine. This indexer follows the full resolution path an `ncc://` client
would: NCC-02 anchor -> NCC-05 locator -> actual HTTP(S)/onion endpoint ->
fetch -> extract page content -> index that content. See
[`src/resolver.js`](src/resolver.js) for the exact contract this implements.

## Pinned resolver contract (source: `imattau/nostr-community-conventions`)

- **`30059`** — NCC-02 Service Record (identity/trust anchor). Tags: `d`
  (service id), `u` (endpoint, optional), `k` (transport-key fingerprint),
  `exp`.
- **`30060`** — NCC-02 Certificate Attestation (optional third-party trust).
- **`30061`** — NCC-02 Revocation. Overrides expiry; a revoked anchor is never
  resolved further.
- **`30058`** — NCC-05 Locator. `d = "<service-id>-locator"` by this repo's
  sidecar convention. Content is normally NIP-04/44 encrypted; this indexer
  only ever resolves it with no signer, so an encrypted payload simply fails
  to decode and is treated as "no locator" — it never attempts to decrypt a
  private locator. That mirrors this project's own public-locator opt-in
  stance (see the root README's callout).

Resolution order, implemented in [`src/resolver.js`](src/resolver.js) by
composing the two reference libraries the sidecar itself depends on
(`ncc-02-js`, `ncc-05-js`) rather than re-implementing signature/expiry/pin
checks:

1. Resolve the NCC-02 anchor first (signature + `exp`, folds in `30060`/
   `30061`).
2. A revoked anchor is dead; stop there, index as unreachable.
3. Resolve the NCC-05 locator for the same identity. If present and fresh,
   its best endpoint (NCC-05's own priority/family ordering) is preferred.
4. Fall back to the NCC-02 `u` tag only if NCC-05 resolution yields nothing
   usable.

## Pipeline

Two adapters, sharing one relay pool, one `fetchUrl()` primitive
([`src/fetcher.js`](src/fetcher.js)), one extractor
([`src/extract.js`](src/extract.js)), and one store
([`src/store.js`](src/store.js)):

```
NCC-02/NCC-05 (src/crawl.js)
  discovery.js   -- broad REQ for kind:30059, discovers (pubkey, serviceId)
                    pairs with no prior npub list needed
  resolver.js    -- AnchoredResolver.resolveService(pubkey, serviceId):
                    the anchor -> locator -> fallback contract above
  fetcher.js     -- fetch the resolved endpoint; verify `k` (SPKI pin) before
                    trusting the response; routes .onion through this host's
                    existing Tor SOCKS listener
  re-crawl cadence driven by the NCC-05 payload's own TTL

nsite (src/adapters/nsite.js + nsite-crawl.js)   -- NIP-5A static sites
  discoverNsites -- broad REQ for kind:15128 (root)/35128 (named); the
                    manifest event IS the resolved record, no second lookup
  NsiteAdapter   -- parses `path`/`server` tags, picks an entry path
                    (/index.html by default), fetches the Blossom blob from
                    a manifest `server` hint or the pubkey's kind:10063
                    (BUD-03) list, and verifies the fetched bytes against
                    the manifest's declared sha256 -- nsite's integrity
                    check, playing the role NCC's `k` pin plays for NCC
  resolveNip05() -- separate, slower pass: reads a pubkey's kind:0 `nip05`
                    field and verifies it against the claimed domain's
                    `.well-known/nostr.json`; attaches the verified handle
                    to every nsite row for that pubkey, or nothing at all
                    if unverifiable (never shown as if confirmed)
  re-crawl on a fixed interval (NIP-5A defines no TTL field)

content (src/adapters/article.js + media.js + content-crawl.js)
  -- NIP-23 articles, NIP-68 pictures, NIP-71 videos
  discoverArticles/discoverMedia -- broad REQ for kind:30023 (articles) and
                    kind:20/21/22/34235/34236 (pictures/videos)
  resolveArticle -- the event's own `content` IS the article (Markdown);
                    stripMarkdown() turns it into FTS-indexable plain text.
                    No fetch step at all -- discovery hands over the full
                    record already resolved.
  resolveMedia   -- parses `imeta` tags (NIP-92, extended by NIP-68/71) for
                    url/m/dim/alt/image/duration. This backend NEVER fetches
                    the media bytes themselves: the browser loads images/
                    video directly from their original host (see ui/), so
                    there is nothing here to verify server-side either --
                    reachability for these two kinds is checked client-side
                    (ui/'s Web Worker), not by this process.
  content-crawl.js -- discover -> resolve -> store immediately (no fetch
                    means no pending/schedule queue at all), plus the same
                    periodic NIP-05 enrichment pass nsite-crawl.js uses,
                    reusing nsite.js's resolveNip05() directly
  hashtags.js    -- shared `t`-tag extraction for article.js/media.js (the
                    only two conventions here that define one). This backend
                    computes no ranking from them itself -- they're exposed
                    so ui/'s NIP-07-signed-in ranking can match them against
                    a user's own interests (see ui/README.md
                    "Personalization")
  resolveMedia also captures the NIP-68/71 `content-warning` tag's value
                    (or a generic "sensitive content" label if the tag has
                    no reason text) as `contentWarning`, stored verbatim and
                    exposed on `/search` results. This backend makes no
                    safety judgment of its own -- it only exposes what the
                    publisher tagged; ui/'s safe-search toggle is what
                    actually filters/labels on it (see ui/README.md
                    "Safe search")

NIP-50 (src/nip11.js + adapters/nip50.js)   -- live search, not a crawl adapter
  Nip11Prober    -- fetches each relay's NIP-11 document (wss:// -> https://,
                    Accept: application/nostr+json), caches whether
                    `supported_nips` includes 50 (NIP-50 "support" isn't
                    something a relay can be probed for directly -- NIP-50
                    itself says to read this from NIP-11)
  Nip50Adapter   -- on a search, issues one `search` REQ to whichever
                    configured relays are capable; every match is fed into
                    the owning crawler's ingestEvent() (same entry point the
                    ambient subscription uses) so it still goes through full
                    resolve/fetch/verify. The hits this returns directly are
                    separate: lightweight, tag-only, explicitly
                    `source: "live"` -- never a substitute for a verified row

store.js  -- one `services` table/FTS5 index for both crawl adapters,
             discriminated by a `kind` column, keyed by (pubkey, item_id) --
             an NCC-02 `d` tag, an nsite's `d` tag, or `_root` for a root
             site. Never keyed by URL, since both NCC-05 and Blossom expect
             the endpoint to move.
server.js -- GET /search?q= (merges the index with live NIP-50 hits, verified
             rows always winning on a (pubkey, itemId) collision; add
             &live=false to skip the live fan-out), GET /services/:pubkey/:itemId
```

## Known caveats / things to verify before relying on this

- **SPKI fingerprint encoding** (`src/fetcher.js: spkiFingerprint`) — verified
  byte-for-byte against the sidecar's actual implementation
  (`computeKFromCertPem` in `ncc-06-js/src/k.js`, pinned commit `186c3ad`):
  SHA-256 of the DER SubjectPublicKeyInfo, encoded as **unpadded base64url**,
  not standard base64. The input bytes were confirmed identical too —
  Node's `tls` socket `PeerCertificate.pubkey` is byte-for-byte the same SPKI
  DER the sidecar derives by reconstructing a public key from the full
  certificate PEM. (The original scaffold used padded base64 here, which
  would have made every TLS endpoint spuriously k-mismatch; fixed.)
- **NCC-02 discovery is open/unauthenticated**: it subscribes to `kind:30059`
  with no author filter, relying on relays allowing broad reads of these
  kinds. Some relays may rate-limit or refuse unfiltered subscriptions at
  scale; a production crawler will likely need per-relay backoff and a
  rotating `since` cursor (stubbed as a no-op reconnect today).
- **Re-crawl key collision**: `crawl.js` keys work items by
  `pubkey\u0000serviceId`; this is safe because `serviceId` comes from the `d`
  tag, not from the URL.
- **nsite legacy kind (34128) is not discovered**: per NIP-5A, new sites
  SHOULD use 15128/35128, and this adapter only looks for those — a site
  published only as the deprecated per-file `kind:34128` events won't be
  indexed. Add it as a third discovery filter if that turns out to matter in
  practice.
- **NIP-05 has no defined relation to nsite in the spec** — attaching it is
  this project's own enrichment (parallel to how NCC-02 attestations add
  trust signal on top of a bare service record), not something NIP-5A asks
  for. It's verified, not trusted blindly: an unverifiable `nip05` claim is
  stored as `null`, never shown as if confirmed.
- **Title/description precedence, store.js**: a real fetched page title must
  beat the manifest's own `title` tag, which must beat nothing. Caught this
  as a live regression while wiring up NIP-05 enrichment — an enrichment-only
  upsert (no content re-fetch) was falling straight to the manifest tag and
  silently downgrading an already-indexed, better title. Fixed in
  `upsertNsite` by reading the existing row first. Re-check this precedence
  (`fetched.title ?? existing?.title ?? resolved.title`) if `upsertNsite`'s
  fallback chain changes again -- it's easy to regress silently because
  every individual upsert still "succeeds".
- **Fixed: a bad relay used to crash the whole process.** Node's native
  (undici-based) global `WebSocket` -- what `nostr-tools`' `SimplePool`
  defaults to -- has a reentrancy bug: its `AbstractRelay.onerror` handler
  calls `this.ws.close()` synchronously from inside the socket's own `error`
  event, which re-enters undici's internal close/fail dispatch and recurses
  until the stack overflows, taking the entire Node process down with it.
  Reproduced directly against both an unreachable port and a momentary error
  from a real public relay (`wss://relay.damus.io`). `src/index.js` now
  constructs the shared `SimplePool` with `websocketImplementation: WebSocket`
  from the `ws` package (already a dependency the sidecar itself uses, for
  the same reason) instead of the native implementation, which does not have
  this bug. This matters for every relay this process ever connects to, not
  just NCC/nsite discovery, since the pool is shared across all adapters --
  a single flaky relay in `NCC_SEARCH_RELAYS` would otherwise have been able
  to kill the whole indexer.
- **Fixed: discovery never actually worked against a real relay, at all.**
  `pool.subscribeMany(relays, filter, params)` in this pinned `nostr-tools`
  version takes a single filter OBJECT as its second argument, not an array
  of filters -- every discovery function in this project
  (`discovery.js`/`article.js`/`media.js`/`nsite.js`) called it as
  `subscribeMany(relays, [filter], {...})`, the array-wrapped shape older
  nostr-tools/NDK-style APIs use. The relay doesn't fail loudly on this: it
  sends `CLOSED ... "bad req: provided filter is not an object"`, which
  `subscribeMany` only surfaces through an `onclose` callback nothing here
  was listening for -- so every subscription silently received zero events,
  forever, with no error anywhere in this project's own logs. The entire
  test suite stayed green throughout, because it exercises `resolve*()`
  functions directly with synthetic events and never exercises the real
  wire call. Only caught by running the real backend against
  `wss://relay.primal.net` end-to-end (prompted by trying this out with a
  real NIP-07 extension) and noticing the database stayed empty; confirmed
  with a standalone script that logged `oneose`/`onclose` explicitly. Fixed
  by removing the array wrapping in all four call sites -- verified with the
  same standalone script: 0 events before, 500 after, against the same live
  relay and filter.
- **NIP-50 adoption is thin and inconsistent** (confirmed while researching
  this project -- strfry's own support was still an open PR at the time of
  writing). Expect `capableRelays()` to return `[]` for most relay lists
  today; `Nip50Adapter.search()` is written to make that the fast, cheap
  path (one cached NIP-11 probe per relay, then nothing), not a degraded one.
- **`SimplePool.querySync` has no built-in timeout** — it waits for every
  queried relay to close its subscription (via eose or a connection error),
  so one slow relay could stall it indefinitely. `Nip50Adapter.search()`
  races it against `config.fetchTimeoutMs` with a manual `Promise.race`
  (same pattern `ncc-05-js`'s own resolver uses, for the same reason) and
  returns `[]` rather than hanging if the race is lost — any events that do
  arrive after the timeout are simply never delivered to this process. That
  does **not** lose data: the ambient relay subscriptions in `crawl.js`/
  `nsite-crawl.js` will still pick the same event up on their own.
- **Live hits are unverified by construction** — a NIP-50 hit is tags read
  straight off a matching event, with no signature/expiry/pin/hash check
  (that happens later, after `ingestEvent()` schedules it for real
  resolution). `server.js` keeps this distinction load-bearing: it never
  lets a live hit overwrite a verified index row with the same
  `(pubkey, itemId)`, only adds live hits for identities not already indexed.
- **Articles/images/videos have no server-checked reachability, by design,
  not omission.** `lastStatus`/`lastReachableAt` are always `null` for these
  three kinds (see `store.upsertContent`'s doc comment) -- this backend
  never fetches media bytes or re-renders article pages, so it has nothing
  truthful to report there. `ui/`'s `useMediaProbe` Web Worker checks image/
  video reachability client-side instead; there is currently no equivalent
  check for whether an article's publishing relays are still up, since an
  article's content is already fully in hand once discovered regardless.
- **Media legacy kind (34125/1063, NIP-94 generic file metadata) is not
  discovered.** Only kind 20 (NIP-68 pictures) and 21/22/34235/34236
  (NIP-71 videos) are indexed. A file shared only as a bare NIP-94 event (no
  NIP-68/71 wrapper) won't be indexed; add it as a fourth media discovery
  filter if that turns out to matter.
- **`ui/`'s CSP needed three separate fixes to actually render media**,
  each caught live, not by reading the spec first: `media-src` for
  `<video>` (`<img>` works via `img-src` alone, which makes this one easy
  to miss), `worker-src 'self' blob:` for the two Web Workers (missing this
  silently stuck every image/video on "checking..." forever in dev, since
  Vite's dev server bootstraps workers via a `blob:` URL), and `img-src
  ...blob:` for the resize worker's `URL.createObjectURL(blob)` result
  (missing this rendered a verified-correct, successfully fetched/decoded/
  resized WebP as a plain broken-image icon). See `ui/README.md`'s "What's
  implemented vs. not" for the full detail on each.

## Storage: unbounded by default, with an opt-in disk-space limit

`store.js` only ever upserts rows — a revoked service gets `is_revoked = 1`
set, but nothing ever deletes a row on its own, so the SQLite file grows for
as long as the crawler keeps discovering new `(pubkey, item_id)` pairs,
bounded only by actual free disk space. Set `NCC_SEARCH_DB_MAX_BYTES` (see
`.env.example`) to opt into a ceiling: `pruneToFit()` evicts the
least-recently-resolved rows (LRU on `last_resolved_at`, the same timestamp
every upsert/re-crawl already keeps current — no separate access-tracking
column needed) on the same tick interval as everything else
(`NCC_SEARCH_TICK_MS`) until the file is back under the limit.

Enabling a limit also switches the database to `auto_vacuum = INCREMENTAL`
(with a one-time `VACUUM` to apply it to an existing file) — without that,
deleting rows only grows SQLite's internal free-page list, and the file on
disk never actually shrinks, which would make "disk space limit" a lie.
That one-time `VACUUM` is paid only when a limit is actually configured, not
on every startup for everyone else.

## Running it

```bash
cd ncc-search
cp .env.example .env   # edit NCC_SEARCH_RELAYS etc.
npm install
npm run dev
```

`GET http://127.0.0.1:7780/search?q=wallet` once the crawler has indexed
something.

## UI

[`ui/`](ui/README.md) — a search-engine-style results page (React+Vite+
TypeScript+Tailwind+Nostrify), built against this backend's `/search`
endpoint. Needs `NCC_SEARCH_CORS_ORIGIN` left unset (the default) or set to
the UI's own origin — the backend's CORS support exists specifically because
the UI runs as a separate origin/port and a plain `fetch` from it fails
silently without CORS headers (caught while standing the two up together).

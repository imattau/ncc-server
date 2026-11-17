# ncc-search

A separate, standalone process that discovers public Nostr-native content —
NCC-02/NCC-05 service records, nsites (NIP-5A), NIP-23 articles, NIP-68/71
pictures and videos, Nostr profiles (kind:0), and npack
(github.com/imattau/npack) package releases — resolves each per its own
normative contract, and serves unified full-text search over the result.

This is not a feature of `ncc-server` or the `ncc-sidecar`: it runs as its own
process/service, reads from the same relay list, and is intended to sit behind
Caddy on its own path, same pattern as every other service in this repo.

## Two processes

The backend is deliberately split into two processes (`ncc-search.service` and
`ncc-search-crawler.service`; two containers off one image in `compose.yaml`):

| | `src/index.js` — crawler | `src/api.js` — API |
|---|---|---|
| writes the index | yes, the only writer | never |
| SQLite connection | read/write | `readonly: true` |
| discovers/subscribes | every crawl adapter | none |
| relay use | discovery + NIP-65 learning | NIP-50 live fan-out per search |
| HTTP | `7781`, private (`src/internal.js`) | `7780`, public API |
| periodic work | re-crawl TTLs, NIP-05, prune | none |

They share one SQLite file over WAL: one writer, many readers, and a reader
sees a committed transaction immediately. That is what keeps the work that can
block a Node event loop — a cheerio parse of a 1 MB page, an FTS5 upsert plus
its fsync, an LRU prune batch — off the request path, and it is why a `/search`
stays fast while 20 crawl fetches are in flight. Either process restarts
without dropping the other; while the crawler is down the API keeps serving the
existing index and `/status` reports `crawlersUnavailable: true`.

The two halves only talk over the crawler's private listener:

- `GET /internal/status` — the in-memory crawl/relay health snapshot, which
  only exists in the crawler process; the API fetches it (1 s timeout) for
  `/status`.
- `POST /internal/ingest` — how a NIP-50 live-search hit reaches the crawler.
  The API does the relay query (read-only), then posts the raw event here, and
  the crawler routes it through the same resolve/fetch/verify path its ambient
  subscriptions use (`src/ingest.js`). Nothing the API sends can write a row
  directly, so this endpoint needs no credentials.

`NCC_SEARCH_CRAWLER_URL` tells the API where that listener is
(`http://search-crawler:7781` in the compose stack, loopback otherwise). The
API retries opening the index until the crawler has created it, so a cold
start in either order is fine.

## nsite edition (browser crawler, no server)

The UI also builds as a static NIP-5A site (`npm run build:nsite`, output
`ui/dist-nsite/`). In that build there is no API server: a Web Worker crawls
the relay-native kinds, keeps the index in IndexedDB, resumes from per-relay
cursors on the next visit, and searches with MiniSearch. It is published with
[`nsite-publisher/`](nsite-publisher/README.md) as
`nsite://<npub>/nccsearch`.

It is deliberately not a mirror of this index: a browser cannot fetch arbitrary
endpoints (CORS), so NCC anchors/locators are not resolved, nothing gets a
reachability or attestation claim, NIP-05 is never verified, and nsite rows are
searchable by their manifest title/description rather than the entry page's
text. It also caps itself at a configurable size (40 MB and roughly 20k
records by default, never more than half the browser's quota). See
[`ui/README.md`'s nsite edition section](ui/README.md#nsite-edition-no-server)
for the full list.

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

profiles (src/adapters/profile.js + profile-crawl.js)  -- Nostr kind:0 metadata
  discoverProfiles -- broad REQ for kind:0; replaceable, so `itemId` is the
                    fixed sentinel `_profile` (same pattern as nsite's
                    `_root`), not derived from anything that could repeat
  resolveProfile -- display_name/name -> title, about -> description,
                    picture -> thumbnailUrl, website -> endpoint. The raw
                    `nip05` field is deliberately NOT read off the event
                    directly -- verified the same way nsite.js's
                    resolveNip05() verifies every other kind's NIP-05 claim,
                    via the same periodic enrichment pass content-crawl.js
                    uses
  -- surfaced in ui/ as a dedicated "Profiles" grid tab (avatars, not
     thumbnails -- see ui/src/components/ProfileGridCard.tsx)

npack (src/adapters/npack.js + npack-crawl.js)   -- github.com/imattau/npack
  package releases (project protocol, not yet a registered NIP; source:
  imattau/npack docs/package-protocol-v1.md, read directly)
  discoverNpackReleases/discoverNpackArtifacts -- broad REQ for kind:9900
                    (a signed release: d/v/name/version/os/arch/format/x/
                    artifact tags, plus optional summary/description/
                    homepage/license/category store-listing tags) and
                    kind:1063 (NIP-94 artifact metadata, carrying the actual
                    download `url`/MIME type) -- two separate events from
                    the same publisher that can arrive in either order
  resolveNpackRelease/resolveNpackArtifact/toSearchRow -- a release is
                    stored as soon as it's seen, searchable by name/summary/
                    description immediately; if its artifact (kind:1063)
                    hasn't arrived yet, npack-crawl.js keeps it pending and
                    re-upserts the row with the download URL/MIME type once
                    the artifact shows up -- store.js's COALESCE semantics
                    mean that second upsert only fills in media_url/
                    media_type, never blanks anything already indexed
  -- this backend never fetches/verifies the `.npk` bytes themselves, same
     stance media.js takes on image/video bytes: a package manager client
     does that, this is a search index, not an installer

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
             the endpoint to move. Title/description fields have higher FTS5
             weight than profile handles and body text.
server.js -- GET /search?q= (merges the index with live NIP-50 hits, verified
             rows always winning on a (pubkey, itemId) collision; add
             &live=false to skip the live fan-out and &sort= to choose the
             order -- see "Posting dates and result order" below), GET
             /services/:pubkey/:itemId, GET /status (aggregate index
             size/counts and crawler health).
             Served by src/api.js only; the crawler (src/index.js) exposes
             just the private health/ingest listener described above.
```

## Posting dates and result order

Article, image, video, nsite and npack rows record `posted_at`: when the event
that produced the row was posted, in unix seconds. For NIP-23 articles the
`published_at` tag wins -- that is the date the author calls the publication
date, and unlike `created_at` it does not move when the article is edited and
republished. Everything else uses the event's `created_at`. Profiles and
NCC-02/05 service rows have no posting date: a kind:0 is a profile *update*,
and an anchored service record has no single source event. `last_resolved_at`
is a different thing (when the crawler last looked) and is still reported as
`indexedAt`.

`GET /search` returns the date as `postedAt` (unix milliseconds, like
`indexedAt`) and accepts `sort=`:

| `sort` | order |
| --- | --- |
| `relevance` (default) | FTS5/bm25 with the anchored/attested/reachable tiebreak |
| `newest`, `oldest` | `posted_at`; rows with no date last in both directions |
| `title`, `title-desc` | title, case-insensitive; untitled rows last |

An unknown or missing `sort` falls back to `relevance`. Rows without a date
always sort last so "oldest" cannot silently mean "we don't know". Every order
ends with `(pubkey, item_id)`, so `limit`/`offset` paging is stable within a
query. Live NIP-50 hits are only merged in for `relevance`: a relay search has
no order this backend could merge into a date or alphabetical sort, and
prepending them would just make the first page look unsorted.

Discovery resumes from per-relay cursors, so rows indexed before `posted_at`
existed are not revisited on their own. `src/backfillPostedAt.js` walks them and
asks the configured relays once per author:

```bash
docker-compose -p ncc-bundle exec search-crawler node src/backfillPostedAt.js --dry-run
docker-compose -p ncc-bundle exec search-crawler node src/backfillPostedAt.js
```

It is safe to re-run -- it only selects rows whose date is still NULL, and the
write itself is guarded the same way -- so a date a crawl stored in the
meantime is never overwritten. Rows a relay cannot resolve stay NULL and are
skipped until the next run; the UI labels those with their index time instead.

It can run while the crawler is writing: each author's dates go in as one
transaction, and the writer connection waits up to ten seconds for a busy
database rather than failing at the first collision. If it does stop, every
page already written is kept and re-running continues from the rows still
missing a date.

## Relay recovery and status

Discovery subscribes to each configured relay independently. If a subscription
closes, it reconnects with exponential backoff capped at five minutes. After
each successful EOSE, the timestamp is stored in SQLite; reconnects and process
restarts resume from that cursor with a five-minute overlap, so duplicate
delivery is safe and recent events are less likely to fall into a gap.
`GET /status` exposes per-adapter relay health, learned relay counts and URLs,
candidate counts, index bytes, free disk bytes, and row counts by kind. Relay
health is process-local; discovery cursors and relay-learning evidence persist
in the database.

### Learning additional relays

By default, the crawler looks up NIP-65 kind 10002 lists for authors already
present in its index. A relay is eligible when at least three distinct indexed
authors advertise it as read-capable (an unmarked NIP-65 `r` tag counts as
read-capable). After a successful bounded connection probe, the crawler can
subscribe to up to ten learned relays in addition to the configured bootstrap
relays. It prefers candidates with stronger author support when the cap is
reached. Candidate URLs must use `wss:` and cannot target localhost or private
IP addresses. Learned relay events still pass through the existing indexing
and verification paths.

Set `NCC_SEARCH_LEARN_RELAYS=false` to disable learning. For the bundled
Compose deployment, use `SEARCH_LEARN_RELAYS=false`. `/status` reports the
candidate and learned counts and the supporting-author count for each learned
relay.

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
  from a real public relay (`wss://relay.damus.io`). `src/pool.js` now
  constructs each process's shared `SimplePool` with
  `websocketImplementation: WebSocket` from the `ws` package (already a
  dependency the sidecar itself uses, for the same reason) instead of the
  native implementation, which does not have this bug. This matters for
  every relay either process connects to, not just NCC/nsite discovery,
  since the pool is shared across all of that process's adapters --
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
npm run dev:crawler    # src/index.js: discovers + indexes, private listener on :7781
npm run dev            # src/api.js: read-only API on :7780
```

`GET http://127.0.0.1:7780/search?q=wallet` once the crawler has indexed
something. Start them in either order: the API retries until the crawler has
created the database. (`npm start` runs only the API, matching the container
image's default `CMD`; the crawler is `npm run start:crawler`.)

## UI

[`ui/`](ui/README.md) — a search-engine-style results page (React+Vite+
TypeScript+Tailwind+Nostrify), built against this backend's `/search`
endpoint. Needs `NCC_SEARCH_CORS_ORIGIN` left unset (the default) or set to
the UI's own origin — the backend's CORS support exists specifically because
the UI runs as a separate origin/port and a plain `fetch` from it fails
silently without CORS headers (caught while standing the two up together).

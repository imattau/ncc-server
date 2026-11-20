# NCC Server admin panel

The static MKStack admin panel is built from `test-app/`. It is the same
single-page app as the public welcome page, with the panel at `/admin`.

The panel and the welcome page follow a light, dark or system theme. The
choice is made from the sun/moon menu in the panel topbar (or the sign-in
gate) and persists with the app configuration, next to the relay list.
`src/lib/theme.ts` applies the saved choice before React mounts so a dark-mode
operator never sees a white flash. The **Apps** page can show its image and
catalogue cards as a grid or a list; the choice is saved separately and is
shared by both card groups.

The panel resolves the operator npub from `/ncc-config.json` (Caddy serves
it dynamically from `NCC_OPERATOR_PUBKEY`, so it survives a content deploy)
or, under `ncc://`, from the address itself, then queries the publication
relays for that key's NCC records (kind 30059 anchors and kind 30058
locators). It shows the real service list, endpoints, certificate pin,
locator freshness, relay delivery and record timestamps.

Sign-in requires a real signer: a NIP-07 browser extension or a NIP-46
remote signer (`bunker://` or the client-initiated `nostrconnect://` flow).
A local nsec login shared with the welcome page is deliberately rejected; the
panel never stores a private key. Mobile browsers cannot load NIP-07
extensions, so the gate detects that and offers "Open signer app (NIP-46)"
instead of a button that cannot work; the same flow shows a QR code for a
signer on another device.

The operator key opens the panel directly. Any other key is checked against
the node's admin list in the sidecar, so an operator can add another admin
from the **Admins** section. Adding a key also makes it an npanel
administrator, and removing one demotes its npanel role to staff; the Admins
table shows both states and can repair a key that never reached npanel. Admin
management, the editable **Settings**
(public identity, publication relays, publication cadence), the **Installed**
service controls and the **Apps** catalogue's publisher trust list are the
write actions in the panel; all are authorized server-side by a NIP-98
signature from the connected key (see below). The panel asks the sidecar to
republish a record, restart a container or pull and recreate one of the
bundle's images; the sidecar forwards container work to the node-agent and
never touches Docker itself, and package installation stays a host command.
Host CPU load, memory and disk are read from the node-agent and shown in the
sidebar and on the overview; anything the agent cannot measure is shown as
`unknown` rather than invented.

NCC records are public, so gating the panel is a usability and honesty
measure, not a confidentiality boundary. Every management action must go
through the NIP-98-authorized API described below.

## Admin API

The sidecar keeps the admin list and the node settings, and listens on host
loopback only. Caddy publishes it at `/ncc-api/*` on the admin listener and
verifies nothing itself: the sidecar checks each request.

- `GET /ncc-api/admins` — list admins and their npanel roles
- `POST /ncc-api/admins` with `{"npub": "npub1…"}` — add an admin, send a
  best-effort invite DM and grant npanel admin access (posting an existing key
  retries that grant)
- `DELETE /ncc-api/admins/<pubkey or npub>` — remove an admin and demote its
  npanel role to staff
- `GET /ncc-api/settings` — read relays, identity, cadence and publication state
- `GET /ncc-api/records` — query the node's published NCC records from its relays
- `GET /ncc-api/services` — health, probe, container and publication state
- `GET /ncc-api/services/<id>/logs?limit=200` — node events and container output
- `GET /ncc-api/metrics` — host CPU, memory, disk and Docker usage
- `GET /ncc-api/images` — the bundle's own images, tags, registry availability and last update result; `?refresh=1` bypasses the registry check cache
- `POST /ncc-api/images/<service>/update` — pull the image tag and recreate the
  container when the digest changed
- `POST /ncc-api/services/<id>/republish` — force one service through a publish cycle
- `POST /ncc-api/services/<id>/restart` — restart the mapped Compose container(s)
- `GET /ncc-api/catalogue` — signed npack service packages and catalogue status
- `GET /ncc-api/catalogue/service?event=<id>` — verify and unpack one release
- `GET /ncc-api/catalogue/icon/<id>` — verified store icon (PNG or SVG)
- `PUT /ncc-api/catalogue/trust` with `{"publisher": "npub1…", "trusted": true}`
  — add or remove a trusted package publisher
- `PUT /ncc-api/settings/relays` with `{"relays": ["wss://…"]}` — replace the
  publication relays
- `PUT /ncc-api/settings/identity` with `{"displayName", "about", "picture",
  "nip05"}` — publish a kind 0 profile for the node
- `PUT /ncc-api/settings/cadence` with `{"refreshIntervalMinutes",
  "ncc02ExpiryDays", "ncc05TtlHours"}` — change how often records refresh

Every request carries `Authorization: Nostr <base64 kind 27235 event>`. The
event is signed by the connected key, tags the exact request URL and method
plus a random nonce, must be under five minutes old, and cannot be replayed.
The five-minute window is deliberate: a NIP-46 signer keeps the template's
`created_at` while the operator approves on a phone, and a one-minute window
made remote sign-in fail whenever approval took longer. The nonce keeps two
requests from the same second distinct, because identical NIP-98 events would
otherwise collide with the replay cache. The sidecar then requires the signer
to be on the admin list. The operator key is protected from removal, and the
last admin cannot be removed.

URL matching accepts the request `Host`, `X-Forwarded-Host`, and the
canonical `NCC_PANEL_PUBLIC_ORIGIN` that Compose passes to the sidecar. It
ignores a trailing slash and tolerates a proxy that omits the default port,
so a TLS-terminating proxy in front of Caddy does not break the signature. A
mismatch now reports both the signed URL and the URLs the sidecar expected,
which is what made the mobile "url tag does not match" failure diagnosable.

### Npanel administrator access

npanel keeps its own `users` table, so a key on the sidecar admin list is not
automatically able to open the npanel dashboard. The sidecar bridges the two
by calling npanel's dashboard API on host loopback, signing with the operator
key's NIP-98 event and sending `Host: <PUBLIC_IPV4>` (npanel routes its
dashboard by Host, and its `dashboard_host` is `PUBLIC_IPV4`):

- adding a node admin creates the npanel user if needed and sets `role=admin`;
- removing a node admin sets `role=staff` instead of deleting the user, so
  sites already granted to that key keep working;
- `GET /ncc-api/admins` returns each key's `npanelRole` and whether npanel
  could be read, so the table shows **Npanel admin**, **Npanel staff** or
  **No npanel access**, with a **Grant** action for a key that is missing
  admin rights.

The node's admin list is always changed first. If npanel is down or rejects
the operator key, the panel keeps the change and shows the reason as a
warning; nothing is rolled back. `NCC_NPANEL_URL` (default
`http://127.0.0.1:3200`) and `NCC_NPANEL_HOST` (Compose sets it to
`PUBLIC_IPV4`) configure the call. A node that does not run npanel reports
`configured: false` and skips the sync. The operator key must itself be an
npanel admin, which first-run provisioning arranges with `make-admin`.

The sidecar also reconciles the list on its own. Shortly after startup, and
then every `NPANEL_RECONCILE_MINUTES` (default 5; set `0` to disable), it
reads npanel's users once and adds any node admin npanel has never seen. That
is what picks up keys added before the mirror existed, or while npanel was
down, without anyone pressing a button. The pass never demotes: an existing
`staff` row is left for **Grant**, so a deliberate npanel demotion is not
undone behind the operator's back.

The dashboard is reachable both at `https://<PUBLIC_IPV4>:8445` and at its
`ncc://` address in the NCC Browser. The latter needs an npanel image built
from 0.7.3 or later: ncc-browser loads a service from the per-service origin
`ncc://<npub>.<service>`, which older NIP-98 checks rejected. The error
`Auth event was signed for npub1….npanel, not …` means the image predates
that fix; see `troubleshooting.md` for the upgrade.

### Settings writes

All settings apply to the whole node, because every standard service shares
the operator identity. The sidecar stores the canonical values in
`app_config` and copies them to each publishing service:

- **Public identity** is the kind 0 profile (`name`, `display_name`, `about`,
  `picture`, `nip05`). The panel requires a display name, accepts an optional
  NIP-05 address and an `https://` picture, and preserves profile fields it
  does not edit. The sidecar service itself is skipped: it has no public
  profile.
- **Publication relays** are normalised to `wss://` (or `ws://`), deduplicated,
  limited to 20, and at least one is required. The list is written to
  `app_config.publication_relays` and to every service, because the publish
  path reads the per-service value first.
- **Publication cadence** is the publish interval, the locator TTL and the
  service-record expiry. Values are range-checked, and a TTL or expiry shorter
  than the publish interval is refused: records would expire before the node
  refreshed them.

A save does not run a publish cycle inline (that can block on Tor and endpoint
probes). It invalidates the relevant hashes and timestamp on each service, so
the normal 60-second cycle republishes anchors, locators and the profile
within about a minute. The panel says so instead of claiming the records are
already updated.

### Record and relay status

The overview and the relay reachability labels are not read from the
browser. NCC Browser pages are not allowed to open WebSockets to public
relays, so every relay appeared "Unreachable" and the records list was empty
under `ncc://`. The panel now asks the sidecar for `GET /ncc-api/records`;
the sidecar queries the configured publication relays (with its own normal
network access), verifies the events, and returns the relay reports and
events. The panel parses those events with the same code it used to use for
its own pool.

If the sidecar image predates the route, the panel falls back to querying the
relays from the browser, which still works over plain `https`; it will keep
showing everything unreachable under `ncc://` until the sidecar is updated.
Relay status in Settings is therefore the node's view of the relays, not the
browser's.

### Installed service controls

The **Installed** page shows live state per service and exposes four actions.
All of them use the same NIP-98 authorization as the settings routes.

- **Health** probes the service from the node, reports the last successful
  publication and its relay results, and merges container state from the
  node-agent. `healthy` means the local probe answered and the published
  record is not stale; `degraded` means a probe, relay, container health check
  or publication age is off; `unreachable` means the probe failed or the
  container is stopped. The panel says `unknown` rather than inventing a
  value when a signal is missing.
- **Republish** runs one forced publish cycle for that service and returns the
  relay results. It is intentionally synchronous so the panel can report a
  failure instead of only claiming a request was queued.
- **Logs** opens two tabs. **Node events** are the sidecar's own log records
  for that service (publishes, Tor, certificates, panel actions). **Container
  output** is recent stdout/stderr from the mapped Compose container. The
  container tab is unavailable when the node-agent is not deployed.
- **Open endpoint** opens the service's canonical `ncc://` address. `web` and
  the legacy `addr` profile open the bare node address; every other service
  opens `ncc://<npub>/<service-id>/`.

Standard services map to the bundle's containers: `web`, `addr` and `admin`
use `caddy`; `relay` uses `relay`; `npanel` uses `npanel`; `ditto` uses
`ditto-web`; and `search` uses `search` and `search-ui`. A custom service
stores its `compose_services` when it is installed with `make service-add`,
so later services are restartable without extra configuration. A service
installed from an npack package also shows its package version and publisher
under the service name. Restarting `web`, `addr` or `admin` restarts Caddy,
which briefly interrupts all three.

The Docker socket is not mounted into the sidecar. A small **node-agent**
companion container reuses the sidecar image, mounts the socket, and exposes
container state, recent logs, restart and image pulls for containers labelled
`com.docker.compose.project=ncc-bundle`, plus host CPU, memory and disk
metrics. The sidecar calls it on host loopback with `NODE_AGENT_TOKEN`. The
agent replies before restarting, so restarting Caddy cannot cut the response
that is proxied through it. Without the agent, the page still shows probe and
publication health and node logs; restart, container logs, image updates and
host metrics are disabled with an explanation.

### Node metrics

The sidebar **Storage** card and the overview's **Node resources** row show
host CPU load, memory use and disk capacity. The node-agent collects them
from sources it already has access to, with no extra mounts or privileges:

- CPU: `/proc/loadavg` and a short `/proc/stat` sample, with the core count
  from Docker's `/info`.
- Memory: `/proc/meminfo` (`MemAvailable` where the kernel provides it).
- Disk: `statfs('/')`, which in a container reports the overlay's backing
  filesystem, i.e. the disk Docker stores containers on.
- Docker data: image, container, volume and build-cache bytes from
  `/system/df`, shown separately from the filesystem total.

The sidecar serves the result at `GET /ncc-api/metrics` after the usual NIP-98
check. Readings are taken when the panel opens and when **Refresh** is
pressed, not on a timer: every read needs a fresh signature, and polling
would make a NIP-46 signer prompt over and over. A host without the agent, or
one where the agent cannot read a source, reports that field as `unknown`;
the panel never fills in a number it did not receive.

### Node images

The **Apps** page starts with the images this bundle runs, not just the npack
catalogue. `compose.yaml` starts plain OCI images (sidecar, relay, npanel,
Ditto web, search, OpenSearch, Caddy, Tor and the node-agent); they are not
signed service packages, so before this list they appeared nowhere in the
panel and could only be updated on the host.

Each card shows the Compose service, its image reference and tag, the image
digest's date, when the registry was last checked and, when there is one,
the result of the last update. The panel asks the node-agent which digest the
registry currently has for the running tag. The Update action only appears
when that digest differs from the image the container runs:

- the check uses Docker's `GET /distribution/<ref>/json`, so the daemon's
  own registry credentials apply;
- results are cached for five minutes; **Check images** bypasses the cache,
  while the page's own load uses it to avoid hammering the registry;
- **Up to date** means the local and remote digests match and no action is
  shown;
- when the registry cannot be reached the card says so and offers a quieter
  **Pull anyway** action rather than claiming an update exists;
- a digest-pinned image is marked as pinned and has no action; a pinned
  release tag still only moves on the host.

**Update** pulls the tag the container runs and recreates the container only
when the pulled digest differs from the running one:

- the pull and the recreate happen on the node, through the node-agent;
- only the bundle's own Compose service names are accepted, and every create
  option (volumes, ports, environment, security settings) comes from the
  running container's own Docker configuration;
- if create or start fails, the previous container is renamed back and
  started, so a bad image cannot leave the service down;
- updating Caddy, the sidecar or the node-agent briefly interrupts this
  panel; the node answers before it starts the work.

The tag is the one in `.env`. `latest` follows new releases, but a pinned
release tag does not move: change `SIDECAR_IMAGE`, `RELAY_IMAGE` and the other
image variables on the host to switch releases. The panel shows the pin rather
than pretending an update exists. A digest-pinned image is marked as such and
has no Update action.

The update runs in a one-shot helper container built from the node-agent's
image. That is what lets it replace the node-agent itself: the helper survives
the container it is recreating. The helper gets the Docker socket and a list
of container IDs the agent already selected; it is not a general Docker
proxy.

A pull can take a few minutes. The page does not poll: every read needs a new
NIP-98 event, which would make a NIP-46 signer prompt repeatedly. Press
**Check images** after a short wait to see the new digest and the result.

### App catalogue

The **Apps** page lists service packages published with
[npack](npack-services.md). The node's `npack` container reads signed
`kind:9900` release events from relays, and the sidecar serves them at
`GET /ncc-api/catalogue` after the usual NIP-98 check.

Each entry shows the store listing the publisher signed (name, summary,
categories, icon, version, publisher) without downloading the artifact. The
details dialog resolves and verifies the `.npk` before showing the image
digest, ports, volumes and environment variable names. Store icons are
fetched by the panel with its NIP-98 header and rendered as blob URLs, so the
icon route is not public.

Trust is per publisher: the key in `NCC_NPACK_OFFICIAL_PUBLISHER` is marked
**Official** and always trusted; other keys show as **Unknown publisher**
until an admin presses **Trust publisher** (a NIP-98 `PUT
/ncc-api/catalogue/trust`). Trusting a publisher trusts its metadata, not its
container image.

The panel does not install packages itself. It shows the verified install
command:

```sh
sudo make service-install REF=<publisher>/<name>@<version>
```

which re-checks the release, artifact hash and descriptor on the node before
touching Compose. Without the `npack` container the catalogue reports itself
unavailable; the rest of the panel keeps working.

**Refresh catalogue** asks npackd to query the relays again. A relay query can
take a while on a slow network, so the node does not hold the panel's request
open for it: it answers at once with the last listing and `refreshing: true`,
and the panel polls until the new catalogue is written (up to about two
minutes). If the query fails, the panel keeps the last listing and shows the
daemon's error with **Try again**. npackd trims its own catalogue to one
refresh every 30 seconds, so pressing the button again immediately can return
the existing catalogue unchanged.

### Sign-in on mobile

The gate only shows the extension button when `window.nostr` exists. On a
phone it explains the gap and leads with the NIP-46 signer-app flow:

1. **Open signer app (NIP-46)** generates a `nostrconnect://` session and
   shows a QR code and a deep link. The operator approves the connection in a
   signer such as Amber; the app returns a `bunker://`-equivalent login that
   the rest of the panel uses.
2. A **Bunker URI** can still be pasted directly when the signer exports one.

`useLoginActions.getRelayUrls()` falls back to the app's default relays even
when they are marked read-only for publishing; nostrconnect only uses them for
the NIP-46 handshake. Without that fallback the handshake had no relays and
failed immediately with "Timeout waiting for remote signer".

If admin verification fails, the gate shows the sidecar's actual error and a
**Try again** button, instead of the previous generic "could not be verified".

Caddy answers the CORS preflight (including `PUT`), strips `Origin` (the NCC
protocol handler rewrites it to a public origin that the sidecar's CORS policy
rejects), and forwards the original `Host` so the sidecar can rebuild the
signed URL. The routes come from
`patches/ncc-sidecar-panel-admin-api.patch`,
`patches/ncc-sidecar-npanel-sync.patch`,
`patches/ncc-sidecar-panel-services.patch`,
`patches/ncc-sidecar-panel-images.patch` and
`patches/ncc-sidecar-npack.patch`, applied when the sidecar image is
built. A sidecar image without the patches answers 401/404, and the panel
falls back to operator-only access with the Admins, Settings, service controls
and catalogue marked inactive; deploy the matching sidecar and Caddy images to
enable them.

`/ncc-config.json` publishes `panelApi`, the absolute base the panel signs.
The panel prefers it over its own origin, because NCC Browser serves `ncc://`
pages from an internal `http://<npub>.admin.localhost:<random>` origin that
is neither the node's public address nor stable across launches. The sidecar
accepts that published base as its canonical `NCC_PANEL_PUBLIC_ORIGIN`, so
the same signature also works from the loopback listener and through a
reverse proxy. The page origin is only a fallback when the node publishes no
base.



## Published NCC service

The Compose bundle publishes the panel as the `admin` NCC service:

- `ncc://<npub>/admin/` (resolves to the `admin` locator)
- `https://<PUBLIC_IPV4>:8448/admin` directly
- `http://<admin-onion>.onion/` over Tor (its own onion endpoint)
- the service root returns a small 200 page that opens `/admin`; it cannot be
  an HTTP 302 because NCC Browser fetches endpoints with manual redirects and
  Electron reports those as "Redirect was cancelled"
- `/ncc-api/*` is proxied to the sidecar admin API, with NIP-98 authorization

The listener uses the shared web certificate and SPKI pin, exactly like the
web/Npanel/Ditto/search listeners. Set `ADMIN_PANEL_TLS_PORT` to change the
port (default 8448). Re-run `sudo make bundle-provision-services` after
upgrading to create and publish the record. Forward the port if clients
should reach it; leave it closed to keep the panel off the network.

The admin service also has its own onion endpoint. Its loopback listener
(`TOR_ADMIN_PORT`, default 18048) serves the same page and `/ncc-api` proxy,
but `/ncc-config.json` publishes `panelApi` from the request Host instead of
the public HTTPS origin. A page opened through the onion therefore signs the
onion URL, and its relative `/ncc-api` requests stay on the onion; the sidecar
accepts that Host as a NIP-98 URL candidate. Sign-in still needs a NIP-07 or
NIP-46 signer that can reach its relays over Tor. See
[deployment](deployment-compose.md) for the one-time
`make bundle-enable-tor` upgrade step.

The service serves the tracked `public/` build, so deploy a build that
includes the `/admin` route (`make build-test-app` and
`make bundle-deploy-test-app`). Older content builds predate the panel and
render the not-found page at `/admin`.

## Loopback listener

The NCC Caddy image also serves the built panel on `127.0.0.1:8081`; it does
not run another web server. Set `CADDY_IMAGE` to a build of
`ncc-server-caddy` to include those assets. The Compose installer sets
`ADMIN_PANEL_PORT=8081` by default. The stack keeps using upstream Caddy when
`CADDY_IMAGE` is unset, and the public `admin` service still works from the
deployed `CONTENT_ROOT` content in that case.

Create an SSH tunnel from the workstation:

```sh
ssh -L 8081:127.0.0.1:8081 user@server
```

Then open `http://127.0.0.1:8081/admin`. The tunnel protects the remote
connection; the loopback listener itself remains bound to host loopback.

## Build and publish

Build locally with Podman from the repository root:

```sh
podman build -f container/caddy/Containerfile -t ncc-server-caddy:dev .
```

The GitHub Actions image workflow publishes `ghcr.io/imattau/ncc-server-caddy`
for `linux/amd64` and `linux/arm64` on a release or manual image build. Once
published, set `CADDY_IMAGE=ghcr.io/imattau/ncc-server-caddy:<tag>` in `.env`
to select it. The default remains upstream Caddy when `CADDY_IMAGE` is unset.

The image build compiles the panel into the Caddy image. The public welcome
page and the `/admin` route are part of the tracked `public/` build, which is
deployed separately with `make build-test-app` and
`make bundle-deploy-test-app`.

The panel requests `/ncc-config.json` and accepts either the bech32 `npub` or
the hex `pubkey`. The bundle's Caddy listeners answer that path from
`NCC_OPERATOR_PUBKEY`, so no bootstrap re-run is needed after a content deploy;
`scripts/publish-web-config.py` still writes a `{"npub": …, "relays": [...]}`
file for plain HTTP use, and the deployment preserves it. When the `relays`
field is missing, the panel falls back to its built-in relay list until the
signed-in operator loads the Settings section; from then on it reads NCC
records from the publication relays the sidecar reports, so changing relays
also changes which relays the panel queries. Caddy also adds `panelApi` for
the signed admin API base.

Admin management, Settings writes and the Installed controls need the
`ncc-api` routes, so the sidecar image, the Caddy configuration and (for
container actions) the `node-agent` service must be current. The Compose file
passes `NCC_OPERATOR_PUBKEY` to the sidecar so it can refuse to remove the
operator key and so `/ncc-api/settings` names the right operator, and
`NODE_AGENT_TOKEN` so it can reach the agent. Caddy's preflight allows
`GET, POST, PUT, DELETE, OPTIONS`.

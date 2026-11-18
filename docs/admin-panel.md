# NCC Server admin panel

The static MKStack admin panel is built from `test-app/`. It is the same
single-page app as the public welcome page, with the panel at `/admin`.

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
from the **Admins** section. Admin management and the editable **Settings**
(public identity, publication relays, publication cadence) are the write
actions in the panel; both are authorized server-side by a NIP-98 signature
from the connected key (see below). Provisioning, restart, log streaming,
republishing and package import stay visible but disabled. The panel cannot
change containers or publish records directly; it asks the sidecar to, and
the sidecar republishes on its own cycle. Host metrics such as CPU and
storage, and per-service health checks, are not collected; the panel shows
"not monitored"/"not collected" rather than invented values.

NCC records are public, so gating the panel is a usability and honesty
measure, not a confidentiality boundary. Every management action must go
through the NIP-98-authorized API described below.

## Admin API

The sidecar keeps the admin list and the node settings, and listens on host
loopback only. Caddy publishes it at `/ncc-api/*` on the admin listener and
verifies nothing itself: the sidecar checks each request.

- `GET /ncc-api/admins` — list admins
- `POST /ncc-api/admins` with `{"npub": "npub1…"}` — add an admin and
  send a best-effort invite DM
- `DELETE /ncc-api/admins/<pubkey or npub>` — remove an admin
- `GET /ncc-api/settings` — read relays, identity, cadence and publication state
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
`patches/ncc-sidecar-panel-admin-api.patch`, applied when the sidecar image is
built. A sidecar image without the patch answers 401/404, and the panel falls
back to operator-only access with the Admins and Settings writes marked
inactive; deploy the matching sidecar and Caddy images to enable them.

`/ncc-config.json` also publishes `panelApi`, the absolute base the panel
signs, because an `ncc://` page cannot see the HTTPS endpoint it was fetched
from. On http(s) the panel uses its own origin instead.



## Published NCC service

The Compose bundle publishes the panel as the `admin` NCC service:

- `ncc://<npub>/admin/` (resolves to the `admin` locator)
- `https://<PUBLIC_IPV4>:8448/admin` directly
- the service root returns a small 200 page that opens `/admin`; it cannot be
  an HTTP 302 because NCC Browser fetches endpoints with manual redirects and
  Electron reports those as "Redirect was cancelled"
- `/ncc-api/*` is proxied to the sidecar admin API, with NIP-98 authorization

The listener uses the shared web certificate and SPKI pin, exactly like the
web/Npanel/Ditto/search listeners. Set `ADMIN_PANEL_TLS_PORT` to change the
port (default 8448). Re-run `sudo make bundle-provision-services` after
upgrading to create and publish the record. Forward the port if clients
should reach it; leave it closed to keep the panel off the network.

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

Admin management and Settings writes need the `ncc-api` routes, so both the
sidecar image and the Caddy configuration must be current. The Compose file
passes `NCC_OPERATOR_PUBKEY` to the sidecar so it can refuse to remove the
operator key and so `/ncc-api/settings` names the right operator. Caddy's
preflight allows `GET, POST, PUT, DELETE, OPTIONS`.

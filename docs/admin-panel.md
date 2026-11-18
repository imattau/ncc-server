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
`bunker://` remote signer. A local nsec login shared with the welcome page is
deliberately rejected; the panel never stores a private key.

The operator key opens the panel directly. Any other key is checked against
the node's admin list in the sidecar, so an operator can add another admin
from the **Admins** section. That is the only write action in the panel, and
it is authorized server-side by a NIP-98 signature from the connected key
(see below). Everything else — provisioning, restart, log streaming,
republishing and package import — stays visible but disabled. The panel cannot
change containers or publish records. Host metrics such as CPU and storage,
and per-service health checks, are not collected; the panel shows "not
monitored"/"not collected" rather than invented values.

NCC records are public, so gating the panel is a usability and honesty
measure, not a confidentiality boundary. Every management action must go
through the NIP-98-authorized API described below.

## Admin API

The sidecar keeps the admin list and listens on host loopback only. Caddy
publishes it at `/ncc-api/*` on the admin listener and verifies nothing
itself: the sidecar checks each request.

- `GET /ncc-api/admins` — list admins
- `POST /ncc-api/admins` with `{"npub": "npub1…"}` — add an admin and
  send a best-effort invite DM
- `DELETE /ncc-api/admins/<pubkey or npub>` — remove an admin

Every request carries `Authorization: Nostr <base64 kind 27235 event>`. The
event is signed by the connected key, tags the exact request URL and method,
must be under a minute old, and cannot be replayed. The sidecar then requires
the signer to be on the admin list. The operator key is protected from removal,
and the last admin cannot be removed.

Caddy answers the CORS preflight, strips `Origin` (the NCC protocol handler
rewrites it to a public origin that the sidecar's CORS policy rejects), and
forwards the original `Host` so the sidecar can rebuild the signed URL. The
routes come from `patches/ncc-sidecar-panel-admin-api.patch`, applied when the
sidecar image is built. A sidecar image without the patch answers 401/404, and
the panel falls back to operator-only access with the section marked inactive;
deploy the matching sidecar and Caddy images to enable it.

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
field is missing, the panel falls back to its built-in relay list. Caddy also
adds `panelApi` for the signed admin API base.

Admin management needs the `ncc-api` routes, so both the sidecar image and the
Caddy configuration must be current. The Compose file passes
`NCC_OPERATOR_PUBKEY` to the sidecar so it can refuse to remove the operator
key.

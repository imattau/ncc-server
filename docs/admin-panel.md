# NCC Server admin panel

The static MKStack admin panel is built from `test-app/`. It is the same
single-page app as the public welcome page, with the panel at `/admin`.

The panel is a UI prototype. Operator-key sign-in, admin changes, container
installs, and locator publication are demo interactions. Nothing verifies a
Nostr signer or authorizes an operator yet, so the panel is not a management
API and it exposes no container control. Connect real signer verification and
authorization before treating it as one.

## Published NCC service

The Compose bundle publishes the panel as the `admin` NCC service:

- `ncc://<npub>/admin/` (resolves to the `admin` locator)
- `https://<PUBLIC_IPV4>:8448/admin` directly
- the service root redirects `/` to `/admin` because NCC Browser joins an
  endpoint's path with the request path, so the endpoint itself must be `/`

The listener uses the shared web certificate and SPKI pin, exactly like the
web/Npanel/Ditto/search listeners. Set `ADMIN_PANEL_TLS_PORT` to change the
port (default 8448). Re-run `sudo make bundle-provision-services` after
upgrading to create and publish the record. Forward the port if clients
should reach it; leave it closed to keep the prototype off the network.

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

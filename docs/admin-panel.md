# NCC Server admin panel image

The NCC Caddy image also contains the static MKStack admin panel built from
`test-app/`. Caddy serves it on `127.0.0.1:8081`; it does not run another web
server and the panel image exposes no container-management API.

The current panel is a UI prototype. Operator-key sign-in, admin changes,
container installs, and locator publication are demo interactions. Keep the
listener loopback-only until real signer verification and authorization are
connected to a server-side management API. Do not publish this prototype as a
public NCC service.

## Open the panel on an installed server

Set `CADDY_IMAGE` to a build of `ncc-server-caddy` to include the panel assets
in the Caddy container. The Compose installer sets `ADMIN_PANEL_PORT=8081` by
default. The stack keeps using upstream Caddy when `CADDY_IMAGE` is unset.
Create an SSH tunnel from the workstation:

```sh
ssh -L 8081:127.0.0.1:8081 user@server
```

Then open `http://127.0.0.1:8081/admin`. The tunnel protects the remote
connection; the panel listener itself remains bound to host loopback.

## Build and publish

Build locally with Podman from the repository root:

```sh
podman build -f container/caddy/Containerfile -t ncc-server-caddy:dev .
```

The GitHub Actions image workflow is configured to publish
`ghcr.io/imattau/ncc-server-caddy` for `linux/amd64` and `linux/arm64` on a
release or manual image build. Once published, set
`CADDY_IMAGE=ghcr.io/imattau/ncc-server-caddy:<tag>` in `.env` to select it.
The default remains upstream Caddy until that image is available.

The build includes the compiled panel assets in the Caddy image. The existing
Compose Caddyfile and public content volume remain mounted at runtime; the
image build does not replace the public welcome page or expose the panel to
the internet.

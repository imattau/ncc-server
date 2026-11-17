# NCC-Server

NCC-Server is a Docker Compose bundle for running NCC services on a Linux
server. It includes the NCC-06 sidecar, Caddy, Npanel, Ditto Relay, Ditto Web,
OpenSearch, and optional Tor onion access.

This guide covers a **new installation** on Debian 12 or Ubuntu. Docker Compose
builds and starts the bundle. On first startup, the bundle creates the operator
identity on the server host (or imports an existing identity JSON file),
provisions the NCC service records, and starts the complete stack. A root-only
host copy is kept outside the container images; services receive the key
through their managed runtime configuration.

## What you need

- A Debian 12 or Ubuntu server or VM with at least 4 GiB RAM and sudo access.
- A stable LAN IP for the server.
- A public IPv4 address reachable by clients.
- Router and firewall access if the services need to be reachable from the
  internet.
- To build and deploy the welcome page: a workstation with Git, SSH, Node.js 22 or newer,
  and npm.

Forward TCP 8443–8448 to expose the NCC services. Port 8080 is optional for
plain HTTP web access; Tor's onion service reaches it locally. You can leave
individual service ports closed if that service should not be reachable.
The admin panel is published as an NCC service on port 8448 and its root
opens `/admin`. The optional panel Caddy image also serves the read-only panel on
loopback port 8081, which needs no router forward; see
[admin panel](docs/admin-panel.md) for SSH access.

| Port | Purpose |
| --- | --- |
| 8080 | HTTP web content and local Tor onion target |
| 8081 | Local-only admin panel (SSH tunnel) |
| 8443 | Pinned HTTPS web content |
| 8444 | Pinned WSS Ditto Relay |
| 8445 | Pinned HTTPS Npanel dashboard |
| 8446 | Pinned HTTPS Ditto Web |
| 8447 | Pinned HTTPS ncc-search UI and API (optional, same origin) |
| 8448 | Pinned HTTPS admin panel (NCC service; read-only) |

Do not forward the internal service ports. Onion access uses Tor and needs no
router port forward. Port forwarding requires a public IP; it will not work
through CGNAT without an external tunnel.

## Install

### 1. Install the Compose bundle on the server

Run on the Debian/Ubuntu server as a single command:

```sh
curl -fsSL https://raw.githubusercontent.com/imattau/ncc-server/main/scripts/quick-install.sh | sudo bash
```

This clones the project to `/opt/ncc-server` (or updates it, if already present)
and runs the same installer as the manual steps below. Review the script
before piping it into `sudo bash` on a host you care about, or clone the repo
yourself and run it locally:

```sh
sudo apt-get update
sudo apt-get install -y git
sudo git clone https://github.com/imattau/ncc-server.git /opt/ncc-server
cd /opt/ncc-server
sudo make install-compose-host
```

The installer creates a private `.env` from `.env.example`, checks the host
has enough RAM/disk and that the required ports are free, tries to
auto-detect the server's public IPv4 address (confirm or type a different one
when prompted), pulls the published component images, and starts the full
stack. During first startup, choose to import an existing identity JSON file
or generate a new keypair. The bootstrap saves it at
`/etc/ncc-server/operator-identity.json` (root-owned, mode 0600), initializes
the sidecar, creates and publishes the `addr`, `web`, `relay`, `npanel`,
`ditto`, `search`, and `admin` records, then brings up Caddy and Ditto Relay. The
`addr` locator points to the same web endpoint, so the bare root address opens
the welcome page. No DNS names or
follow-up provisioning commands are required. Keep an encrypted backup of the
identity file outside the server; it is needed to recover service control.

NCC Browser identifies each service with its signed npub/service locator.
Caddy serves web, relay, Npanel, Ditto Web, search, and the admin panel on
ports 8443 through 8448 respectively.

The installer also writes a placeholder `index.html` into `CONTENT_ROOT` if
it's empty, so `make bundle-health` sees HTTP 200 on the web root even before
you deploy the welcome page.

The custom services use separate public GHCR images. Set their `*_IMAGE`
values in `.env` to pin or upgrade components independently. The
`Publish component images` GitHub Actions workflow publishes multi-platform
images on `v*` tags, or one selected component from its manual dispatch form.
Make each GHCR package public after its first publish so VPS installs can pull
without credentials.

### Unattended / scripted installs

`install-compose-host.sh` only prompts when a value isn't already set. For a
non-interactive run, set these before calling `make install-compose-host`:

| Variable | Purpose |
| --- | --- |
| `PUBLIC_IPV4` | Skips IP auto-detection and the prompt. |
| `NCC_IMPORT_IDENTITY_FILE` | Path to an existing operator identity JSON; skips the generate/import prompt. |
| `NCC_SKIP_PREFLIGHT` | Skips the RAM/disk/port confirmation prompt (the warnings still print). |
| `NCC_SKIP_NAT_CHECK` | Skips the advisory CGNAT/reachability check. |

Pre-flight RAM, disk, and port checks, and the public-IPv4 reachability check,
are advisory: they print warnings but don't stop the install (outside of an
interactive terminal they never block at all). Fix the underlying issue
(free RAM, free a port, get a real public IPv4) rather than relying on the
skip variables if you hit one of these for real.

### 2. Check the installation

Run on the server:

```sh
cd /opt/ncc-server
sudo make bundle-health
```

The installer prints the public npub after setup. The bare address
`ncc://<npub>/` opens the welcome page. Named service addresses include
`ncc://<npub>/relay/`, `ncc://<npub>/npanel/`, `ncc://<npub>/ditto/`, and
`ncc://<npub>/search/` when search is enabled.

## Build and deploy the welcome page

The root page is built with MKStack and includes NCC links to the node's
public services. From the workstation checkout:

```sh
make build-test-app
make bundle-deploy-test-app TARGET=operator@192.168.1.50
```

Replace the target with the SSH account and server address used above. During
first setup, the server writes its public root npub to
`CONTENT_ROOT/ncc-config.json`; the page reads that config when it loads and
builds links for the identity created or imported on that server.

## Operating the bundle

Run these commands from `/opt/ncc-server` on the server:

```sh
sudo make bundle-health
sudo make bundle-logs
sudo make bundle-down
sudo docker-compose -p ncc-bundle -f compose.yaml up -d
```

To grant an npub Npanel administrator access and invite them to manage the
sidecar, run `sudo make bundle-add-admin NPUB=npub1...`. Sidecar access remains
localhost-only and is added as a pending invitation. Ditto Relay has no
additional-admin setting in this Compose bundle.

Service configuration is in `.env`. Persistent service data is stored outside
the containers. Keep `.env`, the operator key, and persistent data backed up;
do not use `docker compose down -v` on an installed server. `make bundle-down`
stops the containers without deleting data or images. `make uninstall` is for
the separate legacy systemd install (see [deployment guide](docs/deployment-compose.md));
it does not apply to this Compose bundle and should not be run against it.

HTTPS uses self-signed certificates. NCC-aware clients validate the
certificate fingerprint published in the service locator; ordinary browsers
will show a certificate warning.

The quick installer installs the bundled welcome page on a fresh server and
updates it on later runs while the web root is still managed by NCC-Server.
Custom site content is left in place. To update the welcome page from a
workstation without rerunning the host installer, use the build and deploy
steps below.

For configuration details and recovery steps, see the
[deployment guide](docs/deployment-compose.md) and
[troubleshooting guide](docs/troubleshooting.md).

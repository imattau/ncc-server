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

Source: [GitHub](https://github.com/imattau/ncc-server); Nostr git mirror:
[gitworkshop.dev/npub1khf5…/relay.ngit.dev/ncc-server](https://gitworkshop.dev/npub1khf5amw8mrupe649a5mhkk3d2d8wjj06urz6kwawpftk4f68tjlstdmd3q/relay.ngit.dev/ncc-server),
kept in sync by the [mirror workflow](docs/nostr-mirror.md).

## What you need

- A Debian 12 or Ubuntu server or VM with at least 4 GiB RAM and sudo access.
- A stable LAN IP for the server.
- A public IPv4 address reachable by clients.
- Router and firewall access if the services need to be reachable from the
  internet.
- To build and deploy the welcome page: a workstation with Git, SSH, Node.js 22 or newer,
  and npm.

Forward TCP 8443–8448 to expose the NCC services. Port 8080 is optional for
plain HTTP web access; the web onion reaches it locally. Every public service
also gets its own onion address: web, relay, Npanel, Ditto Web, ncc-search and
the admin panel. You can leave individual service ports closed if that service
should not be reachable.
The admin panel is published as an NCC service on port 8448 and its root
opens `/admin`. Sign in with the node operator key or an admin key; the Admins
section adds and removes admin keys, Settings edits the published identity,
relays and cadence, and Installed shows health, logs, republish, container
restart and per-service **Access** controls. Every change is a NIP-98-signed
request to the sidecar.
Services publish public locators by default. `make service-private SERVICE=…`
(or the panel's Access dialog) encrypts a service's locator to the operator,
admins and any extra recipient keys; see
[private services](docs/private-services.md). Private is unlisting, not access
control.
The **Apps** page starts with the node's own images, which can be pulled and
recreated from the panel when their tag moved, then lists service packages
published with [npack](docs/npack-services.md), a Nostr-native index for
signed `.npk` descriptors; installing one is `sudo make service-install REF=…`
and the container image still comes from its registry.
The optional panel Caddy image also serves the panel on loopback port 8081,
and the node-agent listens on loopback 3010 for container controls; neither
needs a router forward. See [admin panel](docs/admin-panel.md) for SSH access.

| Port | Purpose |
| --- | --- |
| 80 | Optional public-domain HTTP challenge and redirect |
| 443 | Optional public-domain HTTPS |
| 3010 | Local-only node-agent for panel container controls |
| 8080 | HTTP web content and local target for the web onion |
| 8081 | Local-only admin panel (SSH tunnel) |
| 8443 | Pinned HTTPS web content |
| 8444 | Pinned WSS Ditto Relay |
| 8445 | Pinned HTTPS Npanel dashboard |
| 8446 | Pinned HTTPS Ditto Web |
| 8447 | Pinned HTTPS ncc-search UI and API (optional, same origin) |
| 8448 | Pinned HTTPS admin panel (NCC service; sign-in required) |

Do not forward the internal service ports. Onion access uses Tor and needs no
router port forward. Port forwarding requires a public IP; it will not work
through CGNAT without an external tunnel. The App catalogue's npack daemon
publishes no port at all: the sidecar reaches it through a Unix socket in a
shared volume.

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
The same tag run then creates the GitHub release, after every image is in the
registry, so the panel's upgrade check never offers a release that cannot be
pulled. Add optional hand-written notes as `docs/releases/<tag>.md` before
tagging; otherwise the release uses generated notes. A manual dispatch does
not create a release. Make each GHCR package public after its first publish so
VPS installs can pull without credentials.

The admin panel's Overview page checks the host checkout against the latest
GitHub release. When it is behind, **Upgrade to vX.Y.Z** runs the same full
installer update as `make bundle-upgrade REF=vX.Y.Z`. The installer adds a
fixed root-side systemd helper for this; an install from before v0.2.13 needs
one manual `git checkout v0.2.13` and `make bundle-upgrade` first. See `docs/deployment-compose.md` for
the security model, pinning and recovery notes.

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

Replace the target with the SSH account and server address used above. The
Caddy listeners serve the operator identity at `/ncc-config.json` from the
bundle's environment, and the pages also read the npub from the `ncc://`
address itself, so a wiped config file no longer breaks their links. The
deployment still writes `CONTENT_ROOT/ncc-config.json` as a fallback for plain
HTTP access.

## Operating the bundle

Run these commands from `/opt/ncc-server` on the server:

```sh
sudo make bundle-health
sudo make bundle-logs
sudo make bundle-down
sudo docker-compose -p ncc-bundle -f compose.yaml up -d
```

To add an admin, open the panel's Admins section and paste the npub; the
sidecar stores the key, sends an invite DM and makes the key an npanel
administrator. The key can then open the panel and manage the node. Removing
a key demotes its npanel role to staff rather than deleting the user.
`sudo make bundle-add-admin NPUB=npub1...` remains for recovery or when npanel
is unavailable; it records a pending invitation rather than adding the key from
the panel. Ditto Relay has no additional-admin setting in this Compose bundle.

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

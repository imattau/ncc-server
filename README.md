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
- For the optional test page: a workstation with Git, SSH, Node.js 22 or newer,
  and npm.

Forward TCP 8443 to the server for NCC services. Forward 8447 only when
exposing the optional ncc-search UI and API. Port 8080 is optional for
plain HTTP web access; Tor's onion service reaches it locally.

| Port | Purpose |
| --- | --- |
| 8080 | HTTP web content and local Tor onion target |
| 8443 | Pinned HTTPS and WSS for web, Npanel, Ditto Web, and Ditto Relay |
| 8447 | Pinned HTTPS ncc-search UI and API (optional, same origin) |

Do not forward the internal service ports. Onion access uses Tor and needs no
router port forward. Port forwarding requires a public IP; it will not work
through CGNAT without an external tunnel.

## Install

### 1. Install the Compose bundle on the server

Run on the Debian/Ubuntu server:

```sh
sudo apt-get update
sudo apt-get install -y git
sudo git clone https://github.com/imattau/ncc-server.git /opt/ncc-server
cd /opt/ncc-server
sudo make install-compose-host
```

The installer creates a private `.env` from `.env.example`, asks for the
server's public IPv4 address, builds the images, and starts the full stack.
During first startup, choose to import an existing identity JSON file or
generate a new keypair. The bootstrap saves it at
`/etc/ncc-server/operator-identity.json` (root-owned, mode 0600), initializes
the sidecar, creates and publishes the `web`, `relay`, `npanel`, `ditto`, and
`search` records, then brings up Caddy and Ditto Relay. No DNS names or
follow-up provisioning commands are required. Keep an encrypted backup of the
identity file outside the server; it is needed to recover service control.

NCC Browser identifies each service with its signed npub/service locator and
sends routing metadata to Caddy; Npanel and Ditto Web share HTTPS port 8443.

### 2. Check the installation

Run on the server:

```sh
cd /opt/ncc-server
sudo make bundle-health
```

The installer prints the public npub after setup. NCC Browser can open services using addresses such as
`ncc://<npub>/web/`, `ncc://<npub>/relay/`, `ncc://<npub>/npanel/`, and
`ncc://<npub>/ditto/`.

## Optional: deploy the test page

The included MKStack test app lets you try the web locator. From the
workstation checkout:

```sh
make build-test-app
make bundle-deploy-test-app TARGET=operator@192.168.1.50
```

Run `npm --prefix test-app ci` and `make init-test-identity` once before the
build. This test identity is separate from the server operator key. Replace
the target with the SSH account and server address used above.

## Operating the bundle

Run these commands from `/opt/ncc-server` on the server:

```sh
sudo make bundle-health
sudo make bundle-logs
sudo make bundle-down
sudo docker-compose -p ncc-bundle -f compose.yaml up -d
```

Service configuration is in `.env`. Persistent service data is stored outside
the containers. Keep `.env`, the operator key, and persistent data backed up;
do not use `docker compose down -v` on an installed server.

HTTPS uses self-signed certificates. NCC-aware clients validate the
certificate fingerprint published in the service locator; ordinary browsers
will show a certificate warning.

For configuration details and recovery steps, see the
[deployment guide](docs/deployment-compose.md) and
[troubleshooting guide](docs/troubleshooting.md).

# NCC-Server

NCC-Server is a Docker Compose bundle for running NCC services on a Linux
server. It includes the NCC-06 sidecar, Caddy, Npanel, Ditto Relay, Ditto Web,
OpenSearch, and optional Tor onion access.

This guide covers a **new installation** on Debian 12 or Ubuntu. It assumes
Docker Compose manages the services. The operator key is created and kept on
your workstation, then securely installed on the server.

## What you need

- A Debian 12 or Ubuntu server or VM with at least 4 GiB RAM and sudo access.
- A stable LAN IP for the server.
- A workstation with Git, Node.js 22 or newer, npm, and SSH access to the server.
- A public IPv4 address reachable by clients.
- Router and firewall access if the services need to be reachable from the
  internet.

Forward TCP 8443 to the server for NCC services. Forward 8447 and 8448 only
when exposing the optional ncc-search UI and API. Port 8080 is optional for
plain HTTP web access; Tor's onion service reaches it locally.

| Port | Purpose |
| --- | --- |
| 8080 | HTTP web content and local Tor onion target |
| 8443 | Pinned HTTPS and WSS for web, Npanel, Ditto Web, and Ditto Relay |
| 8447 | Pinned HTTPS ncc-search UI (optional) |
| 8448 | Pinned HTTPS ncc-search API (optional) |

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
sudo cp .env.example .env
sudo chmod 600 .env
sudo make install-compose-host
```

The installer installs Docker and Compose, asks for the server's public IPv4
address, prepares persistent storage, builds the images, and starts the
services needed for initial setup. No DNS names are required. NCC Browser
identifies each service with its signed npub/service locator and sends that
routing metadata to Caddy; Npanel, Ditto Web, and the relay share port 8443.

### 2. Create the operator identity from your workstation

Clone the project on the workstation. The private key stays here; it is not
generated on the server.

```sh
git clone https://github.com/imattau/ncc-server.git ~/ncc-server
cd ~/ncc-server
npm --prefix test-app ci
NCC_SSH_TARGET=operator@192.168.1.50 \
NCC_REMOTE_PROJECT_DIR=/opt/ncc-server \
make first-run-identity
```

Replace `operator@192.168.1.50` with your SSH account and server address. The
command creates a keypair if needed, saves it in the Git-ignored
`.secrets/operator-identity.json` file with owner-only permissions, and
installs the identity on the server over SSH. Keep a secure backup of this
file; it is needed to recover control of the services.

### 3. Create the service records

Run on the server:

```sh
cd /opt/ncc-server
sudo make bundle-provision-services
```

Then run `make first-run-identity` again from the workstation using the same
command as above. This publishes the service records with the operator
identity and starts Caddy and Ditto Relay.

### 4. Check the installation

Run on the server:

```sh
cd /opt/ncc-server
sudo make bundle-health
```

The installer and health check report any missing configuration or services.
The web locator's public identifier is the `npub` printed during identity
setup. NCC Browser can open services using addresses such as
`ncc://<npub>/web/`, `ncc://<npub>/relay/`, `ncc://<npub>/npanel/`, and
`ncc://<npub>/ditto/`.

## Optional: deploy the test page

The included MKStack test app lets you try the web locator. From the
workstation checkout:

```sh
make build-test-app
make bundle-deploy-test-app TARGET=operator@192.168.1.50
```

Replace the target with the same SSH account and server address used above.

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

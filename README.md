# NCC-Server

NCC-Server is a Linux host bundle for publishing Nostr Community Convention
(NCC) service locators and serving the services they describe. The recommended
deployment uses Docker Compose:

- **NCC-06 sidecar** manages service profiles and publishes signed NCC-02 and
  NCC-05 records.
- **Caddy** routes HTTP, pinned HTTPS, and WSS traffic.
- **Ditto Relay** provides the bundled Nostr relay.
- **Npanel** provides the admin dashboard and nsite hosting.
- **Ditto Web** is the bundled web client.
- **Tor** provides an optional onion endpoint for the web service.

The older systemd installation remains available for existing hosts. Use the
Compose deployment for new installs.

## Before you start

- A dedicated Debian 12 or Ubuntu server or VM with at least 4 GiB RAM.
- A stable LAN address for the server. Reserve it in DHCP if router forwards
  will target the VM.
- A public IPv4 address and DNS records for the dashboard, Ditto Web, and relay.
  Direct port forwarding will not work behind CGNAT without an external tunnel.
- Router and host firewall access for TCP **8080**, **8443**, and **8444**.
- A workstation with Git, SSH access to the server, Node.js 22 or newer, and
  npm.

Forward these public ports to the VM and allow them through the host firewall:

| Port | Service |
| --- | --- |
| 8080/TCP | HTTP web content, dashboard, and Ditto Web routing |
| 8443/TCP | Pinned HTTPS web content, nsites, and Ditto Web routing |
| 8444/TCP | WSS Ditto Relay |

Do not forward sidecar port 3000, Npanel ports 3200/3201, relay backend 13131,
OpenSearch ports, or Tor SOCKS/control ports. Tor onion access needs no router
forward.

## Quick start

The setup has one VM terminal and one workstation terminal. Keep the VM
checkout at a path the SSH account can read; /opt/ncc-server is used below.

### 1. Install the base bundle on the VM

~~~sh
sudo apt-get update
sudo apt-get install -y git
sudo git clone https://github.com/imattau/ncc-server.git /opt/ncc-server
cd /opt/ncc-server
sudo cp .env.example .env
sudo chmod 600 .env
sudo make install-compose-host
~~~

The installer prompts for four public values and saves them to .env:

- **PUBLIC_ENDPOINT_HOST**: public IP or hostname for the web locator.
- **DASHBOARD_HOST**: DNS hostname for Npanel.
- **DITTO_WEB_HOST**: DNS hostname for Ditto Web.
- **RELAY_PUBLIC_URL**: public relay URL, such as
  wss://relay.example.net:8444/.

Point those DNS names to your public IP before testing external clients. The
installer configures Docker, storage, pinned images and source checkouts, and
starts the base services. Caddy and the relay wait for identity and service
provisioning.

### 2. Create and install the operator identity

On the workstation, use a separate checkout of this repository:

~~~sh
git clone https://github.com/imattau/ncc-server.git ~/ncc-server
cd ~/ncc-server
npm --prefix test-app ci
NCC_SSH_TARGET=operator@192.168.1.50 \
NCC_REMOTE_PROJECT_DIR=/opt/ncc-server \
make first-run-identity
~~~

Replace operator@192.168.1.50 with your SSH account and VM address. The helper
asks you to confirm before changing the VM. It generates an identity if one
does not already exist, prints its public npub, and stores the keypair in
.secrets/operator-identity.json on the workstation (Git-ignored, mode 0600).
On a clean install, this first pass initializes the sidecar and sets the
Ditto Relay key and Npanel admin. The service records are created in step 3
and aligned on the second pass. Keep a secure offline backup of this file; it
is the recovery source for the service keys.

### 3. Create service records and start the complete stack

Back on the VM:

~~~sh
cd /opt/ncc-server
sudo make bundle-provision-services
~~~

This creates the web, relay, Npanel, and Ditto Web service records, generates
the web and relay self-signed certificates, and configures the web onion
service. Then return to the workstation and run the identity command again:

~~~sh
cd ~/ncc-server
NCC_SSH_TARGET=operator@192.168.1.50 \
NCC_REMOTE_PROJECT_DIR=/opt/ncc-server \
make first-run-identity
~~~

This final pass republishes the locators with the shared identity and starts
Caddy and the relay. It creates a protected backup before migrating existing
identity data.

### 4. Put a page at the web root

For a first install, the included MKStack test app is the quickest way to get a
working page for the web locator and the HTTP/HTTPS smoke check:

~~~sh
cd ~/ncc-server
make build-test-app
make bundle-deploy-test-app TARGET=operator@192.168.1.50
~~~

For a non-root SSH account, the deploy script uses sudo on the VM. The default
content directory is /srv/ncc-server/public; override it with
NCC_CONTENT_ROOT when needed.

### 5. Verify setup

On the VM, check container and endpoint health:

~~~sh
cd /opt/ncc-server
sudo make bundle-health
~~~

On the workstation, verify that a fresh, signed web locator is visible on the
configured relays:

~~~sh
cd ~/ncc-server
make verify NPUB=npub1... SERVICE=web
~~~

Use the npub printed by the identity helper. Other service identifiers are
relay, npanel, and ditto. Open them in NCC Browser with addresses such as
ncc://<npub>/web/ or ncc://<npub>/relay/.

To smoke-test the relay from the workstation:

~~~sh
make test-ditto-wss RELAY_URL=wss://relay.example.net:8444/
~~~

The command performs a WSS NIP-01 request/EOSE exchange. Testing with TLS
verification disabled is intended only for this smoke test; clients should
validate the relay's published certificate pin.

## Public locator and key handling

The Compose defaults publish public NCC-05 locators so clients can resolve the
services without a signer. Relays can read the published endpoint metadata.
Use these defaults only for endpoints intended to be public.

The operator nsec is stored in the workstation's Git-ignored
.secrets/operator-identity.json and a root-owned mode-0600 file at
/etc/ncc-server/operator-identity.json on the VM. Never commit or paste the
private key. Losing it means losing control of services that use that identity.

HTTPS uses self-signed certificates whose SPKI fingerprints are published in
the locator. Regular browsers will show a certificate warning; NCC-aware
clients can verify the published fingerprint.

## Operations

Run from the VM checkout:

~~~sh
sudo make bundle-health
sudo make bundle-logs
sudo make bundle-down
sudo docker-compose -p ncc-bundle -f compose.yaml up -d
~~~

Configuration and step-by-step recovery details are in the
[Compose deployment guide](docs/deployment-compose.md). For problems, see
[troubleshooting](docs/troubleshooting.md). Native systemd deployments are
covered in the [operator guide](docs/operator.md).

## Development and test notes

- [Ditto Relay integration](docs/ditto-relay.md)
- [Ditto Web integration](docs/ditto-web.md)
- [Schema and VM verification results](docs/schema-verification.md)
- [Alternative Podman deployment notes](docs/alternative-podman.md)

The test app source is in [test-app/](test-app/). Caddy serves its built files
from the configured content directory; Node.js is needed only on the
workstation to build the app.

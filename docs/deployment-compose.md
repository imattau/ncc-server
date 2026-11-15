# Compose installation and deployment

This guide explains a fresh Docker Compose installation, networking,
verification, and recovery on a dedicated Debian 12 or Ubuntu host.

The bundle uses Docker Compose for the NCC-06 sidecar, Caddy, Npanel, Ditto
Relay, Ditto Web, ncc-search (the Nostr content search engine and its UI),
OpenSearch, and Tor. Caddy and the sidecar use host networking. Do not
install the bundle where another service owns the ports or Caddy
configuration.

## Requirements and network preparation

### Host

- Debian 12 or Ubuntu with sudo/root access.
- At least 4 GiB RAM; OpenSearch uses a 1 GiB heap.
- Outbound access to Debian package mirrors, Docker registries, GitHub, and
  GitLab.
- A stable LAN address. Create a DHCP reservation if router forwards will
  target the VM.

### Workstation

- Git and SSH access to the VM. Node.js 22 or newer and npm are only needed
  when building the optional test app.

### Public addresses

Set the server's public IPv4 address. No DNS records are required; NCC service
locators publish IP-based URLs. NCC Browser sends the resolved pubkey and
service ID to Caddy in routing headers, allowing core services to share one
HTTPS listener:

| Environment value | Purpose |
| --- | --- |
| PUBLIC_IPV4 | Public IPv4 address clients use to reach the server |

IPv6 is disabled in the default profiles.

Forward and allow these TCP ports:

| Port | Destination | Purpose |
| --- | --- | --- |
| 8080 | VM port 8080 | Optional HTTP; local Tor onion target |
| 8443 | VM port 8443 | Pinned HTTPS and WSS for core NCC services |
| 8445 | VM port 8445 | Pinned HTTPS npanel |
| 8447 | VM port 8447 | Pinned HTTPS ncc-search (UI and API, same origin) |

Only 8443 is required for the core NCC services. Forward 8447 only if you
want ncc-search reachable from outside. Its API shares this same port/origin
as its UI on purpose -- see container/Caddyfile's comment on the search
block for why a separate port for the API broke browser certificate trust
for ncc:// clients. Forward 8445 only if you want to open npanel directly
as a plain https:// address (not via its ncc:// address) -- its own
frontend can't detect it's running embedded when opened via ncc:// (see
container/Caddyfile's comment on the npanel block), so it always falls
back to asking for a manually-typed dashboard address there; opening this
port directly gives it a real origin where that self-detection works.

Do not forward ports 3000, 3200, 3201, 3220, 3230, 9050, 9051, 9200, or 13131.
The sidecar admin port, Npanel backends, ncc-search's own containers, Tor,
OpenSearch, and relay backend are local services. Onion access uses outbound
Tor connections and needs no router forward.

If the server is behind CGNAT or another upstream NAT, router forwards alone
will not make these ports public. Test from a second network where possible;
same-LAN or NAT loopback access does not prove internet reachability.

## 1. Install and initialize the Compose bundle

Clone the project on the VM. The examples use /opt/ncc-server; use the same
directory in all later VM commands.

~~~sh
sudo apt-get update
sudo apt-get install -y git
sudo git clone https://github.com/imattau/ncc-server.git /opt/ncc-server
cd /opt/ncc-server
sudo make install-compose-host
~~~

The installer creates a private `.env` from `.env.example`, prompts for the
server's public IPv4 address, and saves it in `.env`. It installs Docker Engine
and Compose, prepares persistent directories,
stages the pinned Ditto Relay source, builds the images, and starts the stack.
On first startup, choose to import an existing operator identity JSON file or
generate a new keypair. The bootstrap validates imported `nsec`, `npub`, and
`pubkey` values, saves the key at `/etc/ncc-server/operator-identity.json`,
initializes the sidecar, provisions and publishes the service records, and
starts Caddy and Ditto Relay. No separate identity, profile-provisioning, or
second-pass commands are needed for a fresh install.

Persistent data locations are controlled by .env. Defaults include the
sidecar database, generated certificates, Npanel data, Tor data, and
OpenSearch/Caddy named volumes. Keep these paths and volume names stable when
upgrading. Do not run docker compose down -v on an installed server.

The operator identity is stored at
`/etc/ncc-server/operator-identity.json` (root-owned, mode 0600), outside the
container images. Keep an encrypted backup off the server; it is needed to
recover service control. The installer prints the public npub once setup is
complete. Re-running the installer reuses the existing identity. If the
sidecar is initialized but that identity file is missing, setup stops rather
than silently generating a replacement key.

For import, make the JSON identity file available on the server host and enter
its path at the first-start prompt. The source file is left unchanged; the
installer copies it into the root-only identity path after checking that its
`nsec`, `npub`, and `pubkey` values match.

ncc-search never signs or publishes a Nostr event. It only subscribes to relays
(read) and serves its own index over plain HTTP, so it has no operator
identity, signer, or certificate of its own. Its NCC service record is created
by first-start provisioning so clients can resolve its UI.

The first-start provisioner creates the web profile first (sidecar record ID 2) and relay
second (ID 3), followed by Npanel, Ditto Web, and ncc-search. The first two
IDs are fixed because Caddy reads their generated certificate files from
matching paths. All five records use the operator identity -- including
ncc-search's, even though that process itself never signs or publishes an
event; it gets a record purely so it has a discoverable ncc://<npub>/search/
address, the same reasoning as Npanel/Ditto Web. The web profile advertises
HTTPS on port 8443 and maps its onion service to local HTTP port 8080. Npanel
and Ditto Web also use pinned HTTPS on 8443; NCC Browser's routing headers
select their backends. Ditto Relay advertises WSS at
`wss://<IP>:8443/relay/`, which Caddy routes by path so ordinary WebSocket
clients need no custom headers.

The bundle's default publication relays are wss://relay.primal.net/ and
wss://relay.ditto.pub/. The manager profile does not create its own onion
service; Tor is enabled for the web profile.

## 2. Deploy web content

To serve the included MKStack test app, build and deploy from the workstation:

~~~sh
cd ~/ncc-server
npm --prefix test-app ci
make init-test-identity
make build-test-app
make bundle-deploy-test-app TARGET=operator@192.168.1.50
~~~

The deployment stages the files over SSH and installs them into the configured
content directory, /srv/ncc-server/public by default. It can use a local .env
to read CONTENT_ROOT, but a workstation .env is not required. Set
NCC_CONTENT_ROOT for a non-default remote path. A regular SSH account needs
sudo access on the VM; root SSH does not.

You can deploy your own static site instead. Keep the content directory
readable by Caddy. The test app's locator publisher uses its own Git-ignored
test identity on the workstation; it is separate from the server operator
identity.

## 3. Verify the install

Put the test app or your own page in the configured content directory before
running the full health check. On the VM, it checks the web route, dashboard,
Ditto Web, ncc-search's UI and API, relay NIP-11 response, and container
states:

~~~sh
cd /opt/ncc-server
sudo make bundle-health
~~~

The nsite checks are skipped unless you pass SITE_NPUB. The test app uses port
8443, the relay uses port 8444, Npanel uses port 8445, Ditto Web uses port
8446, and ncc-search uses port 8447 for its UI and API. The health check probes
each service on its own port.

If you already host an nsite, include its npub to check its HTTPS route and
root-relative JavaScript asset:

~~~sh
sudo env SITE_NPUB=npub1... make bundle-health
~~~

On the workstation, check that the web locator is fresh and its event signature
is valid:

~~~sh
cd ~/ncc-server
make verify NPUB=npub1... SERVICE=web
~~~

The verifier uses Primal and Ditto by default. To query different relays, pass
them explicitly:

~~~sh
make verify NPUB=npub1... SERVICE=web RELAYS="wss://relay.example/ wss://relay.other/"
~~~

To test the relay's WSS protocol from the workstation:

~~~sh
make test-ditto-wss RELAY_URL=wss://203.0.113.10:8443/relay/
~~~

This test disables TLS verification for the local smoke request because the
relay uses the generated self-signed certificate. It checks a NIP-01
REQ/EOSE exchange. Do not use this setting for regular clients; clients
should verify the relay fingerprint published in its locator.

The expected NCC Browser addresses have the form
ncc://<npub>/<service-id>/, for example ncc://<npub>/web/ or
ncc://<npub>/relay/. Use the npub printed by the installer.

To check the onion endpoint from the VM, use the address printed by service
provisioning:

~~~sh
curl --socks5-hostname 127.0.0.1:9050 -I http://<web-onion-address>.onion/
~~~

Tor may need time to bootstrap and publish the onion descriptor. Do not open
or forward the SOCKS or control ports to the internet.

## Operations

Run Compose commands from the VM project directory:

~~~sh
cd /opt/ncc-server
sudo make bundle-health
sudo make bundle-logs
sudo make bundle-down
sudo docker-compose -p ncc-bundle -f compose.yaml up -d
~~~

You can also use docker-compose -p ncc-bundle -f compose.yaml ps to inspect
service status. The sidecar admin UI listens on loopback port 3000. To access
it remotely, tunnel it over SSH:

~~~sh
ssh -L 3000:127.0.0.1:3000 operator@192.168.1.50
~~~

Then open http://127.0.0.1:3000 on the workstation. Never expose sidecar
admin directly to the internet.

## Recovery and upgrades

The root-only host file `/etc/ncc-server/operator-identity.json` is the source
of truth for the operator identity. Keep an encrypted offline backup. The
server-side identity migration backups under `/var/backups/ncc-server` also
contain signer material and must remain root-only.

Before changing the service identity, the first-run helper creates a backup.
If migration fails, it attempts to restore the matching sidecar database and
Ditto Relay environment automatically. For manual recovery, stop the Compose
stack and restore files from one matching timestamped backup before starting
it again.

The bundle pins sidecar, Npanel, Ditto Relay, and Ditto Web revisions.
ncc-search and its UI build from this repository's own `ncc-search/`
directory instead of a pinned external revision, so they rebuild from
whatever is checked out when you run `make bundle-build`/`bundle-up`. Review
the release notes and back up persistent data before changing a pin or
upgrading images.

The legacy systemd installer and its TLS/Tor scripts are separate. Do not run
them against a Compose deployment.

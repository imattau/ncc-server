# Compose installation and deployment

This guide explains a fresh Docker Compose installation, networking,
verification, and recovery on a dedicated Debian 12 or Ubuntu host.

The bundle uses Docker Compose for the NCC-06 sidecar, Caddy, Npanel, Ditto
Relay, Ditto Web, ncc-search (the Nostr content search engine and its UI),
OpenSearch, Tor, a small node-agent for the admin panel's container controls,
and a read-only npack daemon for the App catalogue. Caddy and the sidecar use
host networking. Do not install the bundle where another service owns the
ports or Caddy configuration.

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
  when building the welcome page.

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
| 8080 | VM port 8080 | Optional HTTP; local target for the web onion |
| 8443 | VM port 8443 | Pinned HTTPS web content |
| 8444 | VM port 8444 | Pinned WSS Ditto Relay |
| 8445 | VM port 8445 | Pinned HTTPS npanel |
| 8446 | VM port 8446 | Pinned HTTPS Ditto Web |
| 8447 | VM port 8447 | Pinned HTTPS ncc-search (UI and API, same origin) |
| 8448 | VM port 8448 | Pinned HTTPS admin panel (NCC service; sign-in required) |

Forward the ports for the services you want clients to reach. ncc-search's UI
and API share port 8447 so browser certificate trust covers both. Npanel uses
its own HTTPS origin on port 8445 because its frontend's instance probe does
not work under the ncc:// origin.

Do not forward ports 3000, 3010, 3200, 3201, 3220, 3230, 8081, 9050, 9051,
9200, 13131, or the `TOR_*_PORT` loopback listeners (18045-18048 by default).
The sidecar admin port, node-agent, Npanel backends, ncc-search's own
containers, the admin panel's loopback listener, Tor, OpenSearch, and relay
backend are local services. `npack` has no published port at all: the sidecar
reaches it through a volume-mounted Unix socket. The onion listeners are
reached only from the Tor process. Onion access uses outbound Tor connections
and needs no router forward.

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
and Compose, prepares persistent directories, pulls the published component
images, and starts the stack.
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

The search backend is two containers off the `SEARCH_IMAGE` image:
`search-crawler` (the only writer of the index, no published port) and
`search` (the read-only API behind Caddy). They share `SEARCH_DATA_DIR` and
communicate over a private listener on the Compose network; see
`ncc-search/README.md`'s "Two processes". Restarting either one alone is safe,
`make bundle-pull` and `bundle-up` handle both, and stopping the crawler leaves
the API serving the existing index.

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
second (ID 3), followed by Npanel, Ditto Web, ncc-search, and the admin
panel. The first two IDs are fixed because Caddy reads their generated
certificate files from matching paths. All six records use the operator
identity -- including ncc-search's and the admin panel's, even though those
processes never sign or publish an event themselves; they get records purely
so they have discoverable ncc://<npub>/search/ and ncc://<npub>/admin/
addresses, the same reasoning as Npanel/Ditto Web. Every public service also
gets its own onion address: `web` maps onion port 80 to local HTTP port 8080,
`relay` maps it to the loopback relay backend on 13131, and Npanel, Ditto Web,
ncc-search and the admin panel map it to dedicated loopback HTTP listeners
(`TOR_NPANEL_PORT`, `TOR_DITTO_WEB_PORT`, `TOR_SEARCH_PORT`,
`TOR_ADMIN_PORT`). Those listeners keep the same Host rewriting as their
public TLS counterparts, and are never published. The default `addr` profile
serves the web page, so it advertises web's onion rather than creating a
second address for the same content.

Relay, Npanel, Ditto Web, ncc-search, and the admin panel advertise HTTPS or
WSS ports 8444, 8445, 8446, 8447, and 8448 respectively. Each profile's
published port matches its dedicated Caddy listener, avoiding cross-service
fallback to the web content root. The admin panel service root opens /admin;
leave it unreachable if you do not want the panel UI published.

The bundle's default publication relays are wss://relay.primal.net/ and
wss://relay.ditto.pub/. The manager profile does not create an onion service
of its own.

## 2. Deploy web content

To serve the included MKStack welcome page, build and deploy from the workstation:

~~~sh
cd ~/ncc-server
npm --prefix test-app ci
make build-test-app
make bundle-deploy-test-app TARGET=operator@192.168.1.50
~~~

The deployment stages the files over SSH and installs them into the configured
content directory, /srv/ncc-server/public by default. It can use a local .env
to read CONTENT_ROOT, but a workstation .env is not required. Set
NCC_CONTENT_ROOT for a non-default remote path. A regular SSH account needs
sudo access on the VM; root SSH does not.

The deployment also republishes the server's public root npub as
`ncc-config.json`, but the Caddy listeners serve `/ncc-config.json` dynamically
from `NCC_OPERATOR_PUBKEY` and the pages fall back to the npub in the `ncc://`
address, so the generated file is only a fallback for plain HTTP access. You
can deploy your own static site instead. Keep the content directory readable
by Caddy.

## 3. Verify the install

Put the welcome page or your own page in the configured content directory before
running the full health check. On the VM, it checks the web route, dashboard,
Ditto Web, ncc-search's UI and API, relay NIP-11 response, and container
states:

~~~sh
cd /opt/ncc-server
sudo make bundle-health
~~~

The nsite checks are skipped unless you pass SITE_NPUB. The test app uses port
8443, the relay uses port 8444, Npanel uses port 8445, Ditto Web uses port
8446, ncc-search uses port 8447 for its UI and API, and the admin panel uses
port 8448. The health check probes each service on its own port.

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
make test-ditto-wss RELAY_URL=wss://203.0.113.10:8444/relay/
~~~

This test disables TLS verification for the local smoke request because the
relay uses the generated self-signed certificate. It checks a NIP-01
REQ/EOSE exchange. Do not use this setting for regular clients; clients
should verify the relay fingerprint published in its locator.

Open the welcome page at `ncc://<npub>/`; this is the identity's default
`addr` service and shares the web endpoint. Named service addresses include
`ncc://<npub>/web/` and `ncc://<npub>/relay/`. Use the npub printed by the
installer.

To check any onion endpoint from the VM, use the addresses printed by service
provisioning (`web`, `relay`, `npanel`, `ditto`, `search`, `admin`):

~~~sh
curl --socks5-hostname 127.0.0.1:9050 -I http://<service-onion-address>.onion/
~~~

For the relay, check the WebSocket endpoint instead:

~~~sh
curl --socks5-hostname 127.0.0.1:9050 -I http://<relay-onion-address>.onion/
~~~

Tor may need time to bootstrap and publish the onion descriptors. Do not open
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

## Manage administrators

Open `ncc://<npub>/admin/` or `https://<PUBLIC_IPV4>:8448/admin`, sign in with
the operator key, open **Admins**, and paste the new npub. The panel asks your
signer for one NIP-98 signature, then the sidecar adds the key and sends it an
invite DM. The key can open the panel immediately and is protected from removal
only while it is not the operator key or the last admin.

Caddy proxies `/ncc-api/*` to the sidecar's loopback listener, and the sidecar
verifies the NIP-98 signature against its admin list. Nothing else is exposed:
the sidecar UI on port 3000 stays local to the host.

From the server checkout, `sudo make bundle-add-admin NPUB=npub1...` still
grants an npub Npanel administrator access and sends a sidecar invitation. That
path records a pending invitation; adding the same key from the panel makes it
active. Ditto Relay does not expose an additional-admin setting through this
Compose bundle, so the command leaves its operator identity unchanged.

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

Each service has its own image and image tag in `.env` (`TOR_IMAGE`,
`SIDECAR_IMAGE`, `RELAY_IMAGE`, `NPANEL_IMAGE`, `DITTO_WEB_IMAGE`,
`SEARCH_IMAGE`, `SEARCH_UI_IMAGE`, and `NPACK_IMAGE`). The `Publish component
images` workflow builds and publishes linux/amd64 and linux/arm64 images,
except the App catalogue's npack daemon, which upstream npack publishes for
amd64 only. A `v*` Git tag publishes a coordinated set; `workflow_dispatch`
can publish one component at a time. The default tags are `latest`; for
controlled upgrades, pin images to version tags in `.env`, then pull and
recreate only the service you changed. `make bundle-pull` refreshes all
configured images, and `make bundle-up` pulls before starting the stack.

When a release adds a new sidecar service record (such as the `admin` panel),
run `sudo make bundle-provision-services` once after upgrading to create and
publish it; the script is idempotent for the existing records.

Releases that add per-service onion endpoints require one extra step on an
existing install. Deploy the release, recreate `caddy` so its loopback onion
listeners exist, then run:

~~~sh
sudo make bundle-enable-tor
~~~

This merges Tor settings into the existing records without rewriting their
profiles, publication relays or cadence, reuses the web onion for `addr`, and
republishes. Fresh installs do this automatically. Adding a custom service
with `make service-add` also creates its onion automatically.

The admin panel's Restart and container-log tabs use the `node-agent`
companion container, which is the only process with the Docker socket. Add a
token to `.env` if the installer did not create one, then recreate both
containers:

~~~sh
grep -q '^NODE_AGENT_TOKEN=..*' .env \
  || printf 'NODE_AGENT_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
sudo docker-compose -p ncc-bundle up -d sidecar node-agent
~~~

The agent binds `127.0.0.1:3010` and only accepts restarts and log reads for
containers labelled `com.docker.compose.project=ncc-bundle`. If it is absent,
the panel still shows probe and record health and the node-event log tab. The
agent runs from `SIDECAR_IMAGE`, so pin that image to a release that includes
`node-agent.mjs` before starting it.

The App catalogue uses the `npack` container, which runs npackd read-only and
answers the sidecar over `/run/npack/npackd.sock`. It has no Docker access and
no published port. Set `NPACK_IMAGE` to a release that exists in your
registry, and `NCC_NPACK_OFFICIAL_PUBLISHER` to the publisher key you want
marked as official:

~~~sh
NPACK_IMAGE=ghcr.io/imattau/ncc-server-npack:0.2.1
NCC_NPACK_OFFICIAL_PUBLISHER=npub1...
~~~

`NPACK_RELAYS` and `NPACK_BLOSSOM_SERVERS` control discovery; their defaults
are npack's public relays and Blossom servers. If the container is missing or
cannot reach the relays, the panel reports the catalogue as unavailable and
every other section keeps working. The catalogue's local state lives in the
`npack-data` volume; keep it with the other bundle volumes.

Installing a service package needs the same release as the sidecar:

~~~sh
sudo make service-install REF=npub1.../hello@1.0.0
~~~

See [npack services](npack-services.md) for the package format and publisher
workflow.

The legacy systemd installer and its TLS/Tor scripts are separate. Do not run
them against a Compose deployment.

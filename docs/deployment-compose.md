# Compose installation and deployment

This guide explains a fresh Docker Compose installation, networking,
verification, and recovery on a dedicated Debian 12 or Ubuntu host.

The bundle uses Docker Compose for the NCC-06 sidecar, Caddy, Npanel, Ditto
Relay, Ditto Web, ncc-search (the Nostr content search engine and its UI),
OpenSearch, Tor, a small node-agent for the admin panel's container controls
and host metrics,
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
and API share port 8447 so browser certificate trust covers both. Npanel keeps
its own HTTPS origin on port 8445: opening its `ncc://` address works too, but
the port is the direct address the docs, healthcheck and curl checks use.

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

`SEARCH_ALLOW_CLIENT_RELAYS` (default `true`) lets the UI send a signed-in
reader's NIP-65 read relays with `/search` for the live NIP-50 fan-out. Those
relays are validated (wss only, no private/local hosts), capped by
`SEARCH_MAX_CLIENT_RELAYS` (default 3), and never ingested into the index; set
it to `false` to keep the API talking only to `SEARCH_RELAYS`. The crawler
indexes NIP-52 calendar events, NIP-53 live streams, NIP-72 communities and
NIP-82/Zapstore app listings by default. App listings are crawled from
`SEARCH_APP_RELAYS` (default `wss://relay.zapstore.dev`) in addition to
`SEARCH_RELAYS`, since general relays rarely carry them. Set
`NCC_SEARCH_ENABLE_EVENTS=false`, `NCC_SEARCH_ENABLE_LIVE=false`,
`NCC_SEARCH_ENABLE_COMMUNITIES=false` or `NCC_SEARCH_ENABLE_APPS=false` on
`search-crawler` to turn any of those off. `ncc-search/README.md` has the
details.

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

### Edge timeouts and response headers

The Caddy configuration applies baseline protections on every browser-facing
listener, including the onion listeners and the system-install Caddyfiles:

- `read_header 10s` bounds the TLS/HTTP header phase, which is the practical
  Slowloris defence for a node that is not behind Cloudflare;
- `read_body 5m` and `idle 5m` bound a slow request body and inactive
  keep-alive connections; the five-minute body window still leaves room for
  large uploads on a slow link;
- request bodies are capped at **5MB** on the static pages, the admin API and
  the relay, and **50MB** on npanel and Ditto web. Custom services generated
  by `make service-add` get the same 50MB cap;
- every response carries `Referrer-Policy: strict-origin-when-cross-origin`
  and `X-Content-Type-Options: nosniff`. The referrer policy still exposes the
  per-service `ncc://<npub>.<service>` origin that NCC Browser's subresource
  routing relies on; it only drops the path.

Caddy reloads its configuration when the bundle recreates the `caddy`
container. For a system install, reinstall the repository's `caddy/Caddyfile`
(or `Caddyfile.tls`) and re-run `sudo make enable-relay-proxy` so the generated
relay snippet gets the same headers. Existing custom `*.caddy` files keep
their old headers until the service is reinstalled; no listener breaks if
they are not regenerated.

## Manage administrators

Open `ncc://<npub>/admin/` or `https://<PUBLIC_IPV4>:8448/admin`, sign in with
the operator key, open **Admins**, and paste the new npub. The panel asks your
signer for one NIP-98 signature, then the sidecar adds the key, sends it an
invite DM and makes it an **npanel administrator**. The key can open the panel
immediately and is protected from removal only while it is not the operator
key or the last admin. Removing a key demotes its npanel role to staff instead
of deleting the user, so sites already granted in npanel keep working.

The npanel grant uses npanel's own dashboard API over host loopback, signed
with the operator key. It needs `NCC_NPANEL_HOST` (Compose sets it to
`PUBLIC_IPV4`) and `NCC_NPANEL_URL` (default `http://127.0.0.1:3200`), and the
operator key must already be an npanel admin. If npanel is down the node change
still applies and the panel shows a warning; the **Grant** action next to a key
retries it. The sidecar also reconciles on its own after startup and every
`NPANEL_RECONCILE_MINUTES` (default 5, `0` disables), adding node admins npanel
has never seen. Recreate the sidecar after pulling a release that adds these
variables.

Caddy proxies `/ncc-api/*` to the sidecar's loopback listener, and the sidecar
verifies the NIP-98 signature against its admin list. Nothing else is exposed:
the sidecar UI on port 3000 stays local to the host.

From the server checkout, `sudo make bundle-add-admin NPUB=npub1...` still
grants an npub Npanel administrator access and sends a sidecar invitation. That
path records a pending invitation; adding the same key from the panel makes it
active and repeats the npanel grant. Ditto Relay does not expose an
additional-admin setting through this Compose bundle, so the command leaves its
operator identity unchanged.

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

The admin panel's Restart and container-log tabs, the Apps page's **Node
images** list, and the sidebar Storage card and Overview resource metrics,
use the `node-agent` companion container, which is the only process with the
Docker socket. Add a token to `.env` if the installer did not create one, then
recreate both containers:

~~~sh
grep -q '^NODE_AGENT_TOKEN=..*' .env \
  || printf 'NODE_AGENT_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
sudo docker-compose -p ncc-bundle up -d sidecar node-agent
~~~

The agent binds `127.0.0.1:3010` and only accepts restarts, log reads and
image updates for containers labelled `com.docker.compose.project=ncc-bundle`.
An update may only name the bundle's own Compose services; it pulls their
image tags and recreates a container only when the digest changed, copying the
container's existing create options. The recreate runs in a one-shot helper
container from the node-agent image, because updating `node-agent` would
otherwise stop the process doing the work. If the agent is absent, the panel
still shows probe and record health and the node-event log tab, the Apps page
lists no images, and the host resource cards say the values are unavailable.
The agent runs from `SIDECAR_IMAGE`, so pin that image to a release that
includes `node-agent.mjs` and `recreate.mjs` before starting it.

Image updates pull the tag in `.env`. `latest` follows new releases; a pinned
tag stays put until you change the variable on the host. The Apps page asks the
node-agent for the registry digest of each running tag and only shows **Update**
when it differs, so the sidecar and node-agent images must both come from the
same release as the panel; an older agent answers the registry check with
"unknown" and the panel keeps its manual **Pull anyway** fallback. Updating
Caddy, the sidecar or the node-agent briefly interrupts the panel, so reload
after the container is back.

### Upgrading the whole server from the panel

The Overview page shows **Upgrade to vX.Y.Z** when
`/var/lib/ncc-server-release/release.json` names an older release than the
latest non-prerelease GitHub release for the checkout's origin. The check is
cached for fifteen minutes. An untagged checkout, a `latest` image with no
release file, or an unreachable GitHub makes the answer unknown and hides the
action; it is never guessed. For a `v*` tag the image workflow creates the
GitHub release only after every component image is pushed, so the button does
not appear while a release is still building.

The button does not run an arbitrary command. The sidecar submits a validated
release tag to the node-agent, which writes
`/var/lib/ncc-server-upgrade/request.json`; the
`ncc-server-upgrade.path` systemd unit runs the fixed
`/usr/local/sbin/ncc-server-upgrade` launcher as root. The runner checks out
the tag, verifies that each image the release pins has a manifest in the
registry (failing with one clear message when they are not published yet),
pins `ghcr.io/imattau/ncc-server-*` values in `.env`, runs
`install-compose-host.sh`, reconciles Tor endpoints, and records the new
release. `install-compose-host.sh` installs the launcher, the path/service
units, the state directories and the release file, so a fresh install and an
upgraded install behave the same.

The `.env` pinning only touches this project's upstream image values. A custom
registry, a digest pin or a different repository is left as-is and reported as
skipped in the upgrade status. `.env` is backed up next to itself before the
rewrite.

An install that predates this feature has no unit or release file, so the first
upgrade is manual after checking out the release:

~~~sh
sudo git fetch --tags origin
sudo git checkout v0.2.13
sudo make bundle-upgrade-dry-run REF=v0.2.13
sudo make bundle-upgrade REF=v0.2.13
~~~

The dry run validates the tag, a clean checkout and the image pins without
changing the host. The real run is the same runner the button uses and installs
the helper. Every later release can be applied from the panel.

The runner refuses to discard tracked local changes; a modified `public/` is
ignored because the installer regenerates it. The status and the last lines of
the installer output are in `/var/lib/ncc-server-upgrade/status.json` and
`upgrade.log`, and `journalctl -u ncc-server-upgrade` has the full log. There is
no automatic rollback. A release that breaks the panel can leave the UI down,
so keep SSH access; to recover, check out the previous tag, restore the saved
`.env` backup from `/var/lib/ncc-server-upgrade/env-backups/`, and run
`sudo make install-compose-host`.

Panel assets are baked into the Caddy image and served at `/admin-static/`.
`CONTENT_ROOT` remains the welcome page, so a Caddy image update also updates
the panel even when an operator replaced the bundled welcome page. The
node-agent container mounts the upgrade state directory read-write and the
release directory read-only; neither contains the operator identity.

The App catalogue uses the `npack` container, which runs npackd read-only and
answers the sidecar over `/run/npack/npackd.sock`. It has no Docker access and
no published port. Set `NPACK_IMAGE` to a release that exists in your
registry, and `NCC_NPACK_OFFICIAL_PUBLISHER` to the publisher key you want
marked as official:

~~~sh
NPACK_IMAGE=ghcr.io/imattau/ncc-server-npack:0.2.9
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

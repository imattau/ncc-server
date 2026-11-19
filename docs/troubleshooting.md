# Troubleshooting

These steps cover the recommended Docker Compose deployment. The older systemd
install is separate; its commands are at the end of this page.

## Check containers and logs

Run on the VM from the NCC-Server checkout:

~~~sh
cd /opt/ncc-server
sudo docker-compose -p ncc-bundle -f compose.yaml ps
sudo docker-compose -p ncc-bundle -f compose.yaml logs --tail=100
sudo make bundle-health
~~~

To narrow logs to one service, replace the final command with, for example:

~~~sh
sudo docker-compose -p ncc-bundle -f compose.yaml logs --tail=100 sidecar
sudo docker-compose -p ncc-bundle -f compose.yaml logs --tail=100 caddy
sudo docker-compose -p ncc-bundle -f compose.yaml logs --tail=100 tor
sudo docker-compose -p ncc-bundle -f compose.yaml logs --tail=100 relay
~~~

If Compose reports missing variables or volumes, check that you are in the VM
checkout and that its .env file exists. Validate configuration with:

~~~sh
sudo docker-compose -p ncc-bundle -f compose.yaml config
~~~

## Web page or dashboard does not load

Check the listeners from the VM:

~~~sh
curl -I http://127.0.0.1:8080/
set -a; . /opt/ncc-server/.env; set +a
curl --insecure -I https://127.0.0.1:8443/
curl --insecure -I https://127.0.0.1:8444/relay/
curl --insecure -I https://127.0.0.1:8445/api/instance
curl --insecure -I https://127.0.0.1:8446/
curl --insecure -I https://127.0.0.1:8447/
curl --insecure -I https://127.0.0.1:8448/admin
~~~

Each service has its own listener: web 8443, relay 8444, Npanel 8445, Ditto
Web 8446, search 8447, and the admin panel 8448. Requests use the server IP
directly; no DNS names are needed.

For an empty web root, deploy the MKStack welcome page or place your own files in
the CONTENT_ROOT directory from .env. Check that files are readable by the
Caddy container. A 404 on the web root before content is installed does not
mean the container failed.

If the local checks work but an external client cannot connect, check the host
firewall and router forwards to the VM's current LAN IP. Test from a second
network; same-LAN NAT loopback can give misleading results. Ordinary port
forwarding will not work behind CGNAT without an external tunnel.

## Locator missing, stale, or has the wrong endpoint

On the workstation, install the test app dependencies if not already present,
then verify the published event:

~~~sh
npm --prefix test-app ci
make verify NPUB=npub1... SERVICE=web
~~~

The verifier checks a fresh signed locator on Primal and Ditto by default.
Other service IDs are relay, npanel, and ditto. Confirm the locator endpoint,
the service identifier tag, and the expiry. Compose defaults publish public
locators; relays can read their endpoint metadata.

If a locator is absent or stale:

- Confirm the matching service record is active in the sidecar.
- Check the sidecar logs for relay connection and acknowledgement errors.
- Confirm the service profile uses the correct public IPv4 address and port.
- Verify the default relays can be reached from the VM.
- Republish after changing a service profile.

The bundle defaults to wss://relay.primal.net/ and wss://relay.ditto.pub/.
If changing those values, update the sidecar publication list and service
profiles together.

The host installer enables `ncc-public-ip-reconcile.timer`, which checks the
outbound public IPv4 every 15 minutes. When it changes, the reconciler updates
the `web`, `relay`, `npanel`, `ditto`, and `search` profiles, updates the saved
Compose and Relay configuration, rebuilds the search UI with its new address,
recreates the affected containers, and republishes all five locators. The
operation is safe to retry; a pending change is recorded under
`/var/lib/ncc-server/` until publication succeeds.

Check the timer and recent run logs with:

~~~sh
systemctl status ncc-public-ip-reconcile.timer
sudo journalctl -u ncc-public-ip-reconcile.service -n 100 --no-pager
~~~

To reconcile immediately, run
`sudo /path/to/ncc-server/scripts/reconcile-public-ip.py` from the deployed
checkout. If a run fails, inspect the service logs and sidecar logs, resolve the
reported profile, Docker, or relay connectivity issue, then run the command
again. Confirm fresh signed locators contain the current endpoint before
relying on them. The check observes the outbound public address; it does not
detect a router or ISP port-forwarding problem.

## Relay WSS connection fails

From the VM, check relay NIP-11:

~~~sh
curl --insecure -H 'Accept: application/nostr+json' https://127.0.0.1:8444/relay/
~~~

Then check Caddy and relay logs. Verify that TCP 8444 reaches the VM, Caddy is
using the relay's pinned certificate, and the relay backend is healthy on
loopback port 13131. Do not forward 13131.

From a workstation with Node.js 22 or newer, run:

~~~sh
make test-ditto-wss RELAY_URL=wss://203.0.113.10:8444/relay/
~~~

The smoke script skips certificate verification only for this test. NCC
clients should use the certificate pin in the signed relay locator.

## Installed service controls are unavailable

The **Installed** page shows health and node-event logs from the sidecar even
without the host agent. Restart and the **Container output** log tab need the
`node-agent` companion container:

~~~sh
sudo docker-compose -p ncc-bundle ps node-agent
sudo docker-compose -p ncc-bundle logs --tail=100 node-agent sidecar
~~~

If the agent is not running, recreate it with the sidecar:

~~~sh
sudo docker-compose -p ncc-bundle up -d sidecar node-agent
~~~

A `401` from the agent means `NODE_AGENT_TOKEN` differs between the two
containers; both read it from the same `.env`. A `503` mentioning Docker means
the agent cannot reach `/var/run/docker.sock`. The agent runs as root only to
use that socket, accepts restarts only for containers in the `ncc-bundle`
project, and binds `127.0.0.1:3010`.

The sidebar **Storage** card and the overview's **Node resources** row use
the same agent. `Host metrics unavailable` means the sidecar could not reach
it; the tooltip carries the agent's error. CPU load and memory are the host's
`/proc` values as seen from the container (normally host-wide), disk is the
filesystem Docker stores containers on, and the Docker-data line is
`/system/df`. Metrics are read when the panel loads or **Refresh** is pressed,
not on a timer, so a remote signer is not asked to approve signatures
repeatedly.

Restarting `web`, `addr` or `admin` restarts Caddy, so the panel page can
briefly stop responding; reload it after a few seconds. Health is computed
from the service's local probe, the last publication result and container
state. `Unreachable` with a running container usually means the probe target
in the service record is wrong; `Degraded` usually means a relay publish
failed or the record is older than twice the publish interval.

## Admin changes do not reach npanel

Adding a key from the panel writes the node admin list first, then grants
npanel administrator access through npanel's dashboard API. A key that can
open `/admin` but not the npanel dashboard is shown as **No npanel access**
with a **Grant** action.

Check that npanel is running and that its dashboard answers on its configured
host:

~~~sh
sudo docker-compose -p ncc-bundle ps npanel sidecar
PUBLIC_IPV4=$(sed -n 's/^PUBLIC_IPV4=//p' .env)
curl -s -H "Host: ${PUBLIC_IPV4}" http://127.0.0.1:3200/api/instance
~~~

- Connection refused means npanel is stopped, or `NCC_NPANEL_URL` points
  somewhere else. Recreate the sidecar after changing that variable.
- `This domain is not configured` (404) means `NCC_NPANEL_HOST` does not match
  npanel's `dashboard_host`. Compose sets both from `PUBLIC_IPV4`.
- `401` means npanel rejected the signed URL, usually because the sidecar image
  predates the sync or does not match the panel build.
- `403` means the operator key is not an npanel admin. The panel cannot
  bootstrap that itself; grant it on the host, then use **Grant** in the
  Admins table:

~~~sh
NODE_PUBKEY=$(sed -n 's/^NCC_OPERATOR_PUBKEY=//p' .env)
sudo docker-compose -p ncc-bundle exec npanel \
  npanel --config /tmp/npanel.toml make-admin "$NODE_PUBKEY"
~~~

`sudo make bundle-add-admin NPUB=<npub>` does the same for any key and also
sends a sidecar invite.

The node change always succeeds first. If npanel is down or rejects the call,
the panel keeps the change and shows the reason as a warning; nothing is rolled
back. Removing a node admin demotes the npanel user to `staff` instead of
deleting it, so site grants made in npanel keep working. npanel refuses to
demote its last admin, which is also reported as a warning.

## npanel sign-in fails with "Auth event was signed for …"

If the npanel dashboard refuses every authenticated request with

~~~text
Auth event was signed for npub1….npanel, not 107.x.x.x
~~~

the page was opened at its `ncc://` address and the running npanel image is
older than 0.7.3. ncc-browser loads a service from the per-service origin
`ncc://<npub>.<service>`, while those npanel releases only accepted the bare
`ncc://<npub>` form in NIP-98, so the signature was made for a host npanel
would not accept.

Either open the https origin instead (`https://<PUBLIC_IPV4>:8445`, the direct
address), or upgrade `NPANEL_IMAGE` to a release built from npanel 0.7.3 or
later and recreate the container:

~~~sh
NPANEL_IMAGE=ghcr.io/imattau/ncc-server-npanel:0.2.7
sudo docker-compose -p ncc-bundle pull npanel
sudo docker-compose -p ncc-bundle up -d --force-recreate npanel
~~~

This is npanel's own NIP-98 host check, not the sidecar's admin sync;
`NCC_PUBKEY` is already set from the operator key.

## Search results, events, shorts or live streams are missing

`search-crawler` indexes NIP-23 articles, NIP-68/71 pictures and videos,
NIP-52 calendar events (`31922`/`31923`), NIP-53 live streams (`30311`),
nsites, npack releases, NCC service records and profiles. Event and live-stream
discovery starts from the beginning the first time the adapter runs, so those
tabs can stay empty for a while on a large relay history; check
`/status`'s `rowsByKind` or the container logs for the `events` and
`live-streams` sources.

The **Shorts** tab only contains rows indexed as `short-video` (NIP-71 kinds
`22`/`34236`). Rows indexed before that split are still `video`. Relabel them
once with the maintenance script:

~~~sh
sudo docker-compose -p ncc-bundle exec search-crawler \
  node src/reclassifyVideoKinds.js --dry-run
sudo docker-compose -p ncc-bundle exec search-crawler \
  node src/reclassifyVideoKinds.js
~~~

If **use my NIP-65 relay list** has no effect on live results, check:

- the reader is signed in and their kind:10002 event has at least one `r` tag
  with no marker or `read`;
- `SEARCH_ALLOW_CLIENT_RELAYS` is not `false` on the `search` service
  (`docker-compose -p ncc-bundle exec search printenv | grep NCC_SEARCH_ALLOW`);
- the relay advertises NIP-50 in its NIP-11 document. The node's own index is
  unchanged by this setting; only live, `source: "live"` hits use those relays.

## App catalogue is empty or unavailable

The **Apps** page reads signed service packages from the node's `npack`
container. Check the container and the socket:

~~~sh
sudo docker-compose -p ncc-bundle ps npack
sudo docker-compose -p ncc-bundle logs --tail=100 npack sidecar
sudo docker-compose -p ncc-bundle exec npack test -S /run/npack/npackd.sock
~~~

- “The npack catalogue service is not running” means the sidecar cannot see
  the socket. Both containers mount the `npack-run` volume; recreate them
  with `sudo docker-compose -p ncc-bundle up -d npack sidecar`.
- A daemon error about relays means `NPACK_RELAYS` is unreachable or set to
  an empty list. The public defaults are `wss://relay.damus.io`,
  `wss://nos.lol` and `wss://relay.primal.net`.
- An empty catalogue can simply mean no one has published an
  `ncc-service` package yet on those relays. **Refresh catalogue** in the
  panel rebuilds it. Publishers can check discovery with
  `npack search --kind ncc-service --refresh --relay …`.
- **Refresh catalogue** returns immediately with the previous listing while
  npackd queries relays in the background; the panel polls for up to about
  two minutes. If the pill still says refreshing after that, the relay query
  is slow or failing. Read the daemon log for the relay error, check outbound
  `wss://` access from the `npack` container, and press **Try again** once
  it is fixed. A refresh click can also be a no-op: npackd treats a catalogue
  younger than 30 seconds as fresh.
- “Unknown publisher” is normal until an admin presses **Trust publisher**, or
  the key is set in `NCC_NPACK_OFFICIAL_PUBLISHER`.
- A package that fails to resolve with a hash or signature error is not a
  bug in the node: the release event, the artifact hash, or the download URL
  is inconsistent. Ask the publisher to republish a corrected release; npack
  never accepts bytes that do not match the signed SHA-256.

Installing a local `.npk` with `NPK=` needs `zstd` on the host. The
`REF=` path extracts inside the sidecar and does not.

The published npack image is amd64-only (upstream npack ships amd64 Linux
packages). An arm64 host will report the catalogue as unavailable; the panel
and service controls still work.

## Onion endpoint does not load

Tor has to bootstrap and publish an onion descriptor. Check the Tor and
sidecar logs:

~~~sh
sudo docker-compose -p ncc-bundle -f compose.yaml logs --tail=100 tor
sudo docker-compose -p ncc-bundle -f compose.yaml logs --tail=100 sidecar
~~~

The standard Compose provisioner enables Tor for every public service: web
maps onion port 80 to local HTTP port 8080, the relay maps it to the loopback
relay backend, and Npanel, Ditto Web, ncc-search and the admin panel map it to
the loopback HTTP listeners in `container/Caddyfile`. Each service should
show its own onion address. Check the addresses printed by the provisioner or
`make bundle-enable-tor` against the current locators. Test from the VM:

~~~sh
curl --socks5-hostname 127.0.0.1:9050 -I http://<service-onion-address>.onion/
~~~

Tor can take several minutes to bootstrap or publish a descriptor. Onion
services require no incoming router forward. Keep SOCKS port 9050 and control
port 9051 bound to loopback; never forward them.

If a service's onion address resolves but the page fails, check that its
loopback listener is up and bound to 127.0.0.1:

~~~sh
sudo ss -ltn | grep -E ':(18045|18046|18047|18048|13131) '
~~~

These are the Npanel, Ditto Web, ncc-search, admin and relay targets. If they
are missing, deploy the current `container/Caddyfile` and recreate `caddy`,
then run `sudo make bundle-enable-tor`.

## Identity setup or migration fails

The workstation key is saved in .secrets/operator-identity.json. The helper
does not overwrite an invalid existing key. Check that SSH works and that the
remote checkout path passed through NCC_REMOTE_PROJECT_DIR is correct. For a
non-root SSH account, sudo must be available on the VM.

Before migrating an initialized sidecar, the helper creates a protected backup
under /var/backups/ncc-server. If it reports rollback, inspect the matching
backup and sidecar logs. Do not delete the workstation key or backup while
recovering.

## Legacy systemd installation

Use the following only on hosts installed with the native systemd path:

~~~sh
systemctl status caddy ncc-sidecar --no-pager
journalctl -u caddy -u ncc-sidecar --since '30 minutes ago'
systemctl cat caddy
systemctl cat ncc-sidecar
~~~

Do not use native install, uninstall, TLS, or Tor scripts on a Compose host.

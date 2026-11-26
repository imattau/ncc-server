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

## A public domain does not load

The optional **Installed → Domain** feature is a standard HTTPS front door.
It does not change `ncc://` records, so if the old address works and the domain
does not, the problem is DNS, port reachability or certificate issuance.

Check:

~~~sh
dig +short ditto.example.com
sudo ss -ltnp | grep -E ':(80|443) '
sudo docker-compose -p ncc-bundle logs --tail=200 caddy
sudo docker-compose -p ncc-bundle logs --tail=200 node-agent sidecar
~~~

- **DNS:** the name must resolve to the node's public address.
- **Ports:** allow TCP 80 and 443; Caddy needs one of them for ACME.
- **Another web server:** do not run the bundle where Apache, nginx or another
  Caddy already owns 80/443.
- **Node-agent:** saving the domain needs the agent to write
  `custom-services/caddy/50-ncc-public-domains.caddy` and reload Caddy.
- **Certificate:** issuance happens in the background after saving. The first
  HTTPS request can be slow while Caddy completes it.
- **`npanel`:** its dashboard is excluded because it routes by one
  `dashboard_host`; configure npanel itself for a panel domain.

The generated file is safe to inspect. Do not edit it by hand; save the domain
again from the panel to regenerate it.

## An image update does not change the image

The **Apps** page lists the bundle's own images and asks the node-agent which
digest the registry has for the running tag. **Update** only appears when that
digest differs from the image the container runs. It pulls the tag the
container currently runs and recreates the container only when the pulled
digest differs. A pinned tag therefore stays where it is: `0.2.8` will not
turn into `0.2.9`. Change the image variable in `.env` on the host
(`SIDECAR_IMAGE`, `RELAY_IMAGE`, and so on), then recreate the pair as
described in the deployment guide. `latest` is the only tag that follows new
releases by itself.

A card that says **Up to date** has nothing to do, and there is no button.
**Could not compare with the registry** means the daemon could not reach the
registry (offline, rate-limited, a private image without host credentials, or
a registry mirror). The card keeps a quieter **Pull anyway** action for that
case. Press **Check images** to retry the comparison after the network or
credentials are fixed.

Other messages:

- `Host control agent is not configured` or `Image updates need the
  node-agent` means the companion container is missing or has no token. Add
  `NODE_AGENT_TOKEN` and recreate `sidecar node-agent`.
- `No bundle image is named …` means the panel and sidecar images do not
  match; deploy the Caddy and sidecar images from the same release.
- `An image update is already in progress` is the agent refusing a second
  pull. Wait for the first one and press **Check images**.
- **Update all** works through the images one at a time. A failed image does
  not stop the remaining ones; the progress bar shows how many failed, and a
  card keeps the registry or container error.
- The progress bar stops moving if the sidecar or node-agent restarts while
  it is updating them. The work may still have completed: press **Check
  images**.
- A card stuck on `Recreating the container…` usually means the container
  failed to start and was rolled back to the previous image. Read the failed
  result, then check its logs on the **Installed** page or with `docker
  logs`.
- A pull denied by the registry fails before anything is recreated. The agent
  pulls anonymously; for a private registry, update the image on the host
  with `docker-compose -p ncc-bundle pull <service>` instead.

Updating `caddy`, `sidecar` or `node-agent` briefly interrupts this panel.
Wait a few seconds and reload; the new container is already being started.

## Disk is filling up

The sidebar Storage card shows the host filesystem and, separately, the
space Docker uses for images, containers, volumes and build cache. The
filesystem figure alone does not say which one is growing; the Docker line
does.

Old release images are the usual cause on a node that upgrades regularly:
every upgrade pulls a new set of tags and Docker keeps the previous one
because a tag still points at it. **Apps → Clean up images** previews the
tags no container uses and removes them after confirmation. The previous
release is kept by default so a manual rollback still works; clear that
checkbox to remove it too. The panel reports the space Docker actually
freed. It only considers repositories this bundle runs and never touches an
image a project container uses, so unrelated images and other projects are
safe.

What it deliberately leaves alone:

- untagged (dangling) layers, which cannot be attributed to this bundle.
  Remove them with `docker image prune` on the host if `docker system df`
  shows them;
- images in repositories the bundle stopped running. Remove those by name
  with `docker image rmi <ref>` once you are sure nothing else needs them;
- volumes and build cache. Neither is created by an image pull, so neither is
  part of this action.

`docker image prune` on its own does not remove the old release tags: they
are still tagged, so only `-a` or naming the tag would delete them. Prefer
the panel action, which keeps the previous release and cannot touch another
project's images.

## A server upgrade is unavailable or fails

The **Upgrade to vX.Y.Z** button appears only when the current release tag and
the latest GitHub release are both known and the host is behind. If it is
missing:

- the checkout is not on a release tag and the running sidecar image has no
  version tag (for example `latest`);
- GitHub was unreachable, rate-limited or returned no version tag;
- the node is already current.

The release check is cached for fifteen minutes. Reopen the panel or call the
endpoint with `?refresh=1` after fixing connectivity.

If the button is present but disabled, the host helper is missing or the state
directory is not writable. Re-run the installer once on the host:

~~~sh
sudo make install-compose-host
~~~

That installs `/usr/local/sbin/ncc-server-upgrade`,
`ncc-server-upgrade.path`, `ncc-server-upgrade.service`, the state
directories and the release file. Check them with
`systemctl status ncc-server-upgrade.path` and `journalctl -u
ncc-server-upgrade`.

Other messages:

- `The server checkout has local changes` means the runner refused to discard
  tracked edits. Commit or discard them on the host. A locally rebuilt
  `public/` does not count.
- `A server upgrade is already in progress` comes from the node-agent while a
  request is pending or the status is `running`. Wait for it; if the runner
  died, inspect `systemctl status ncc-server-upgrade.service` and the status
  file before starting another.
- The panel goes blank or loses the API for a minute during the installer.
  That is expected while Caddy and the sidecar are recreated. The status file
  and the progress token are on disk; keep the page open or reload and the
  panel resumes.
- `This upgrade progress token is invalid or expired` after a long run means
  the one-hour token expired. Reload the panel; the check endpoint mints a new
  token for a running job.
- A failed step is shown with the last installer lines. The full log is
  `/var/lib/ncc-server-upgrade/upgrade.log`; the journal has the systemd
  wrapper output. There is no automatic rollback. Check out the previous tag,
  restore the `.env` backup from
  `/var/lib/ncc-server-upgrade/env-backups/`, and run
  `sudo make install-compose-host` to recover.
- `RELAY_IMAGE` or another image is listed as skipped in the pins means it
  points at a custom registry, a different repository or a digest. The runner
  deliberately left it alone; update that image on the host yourself.
- `detected dubious ownership` means the checkout belongs to a different
  user. The installer expects a root-owned checkout; restore that layout or
  add the path to root's `safe.directory` before retrying.

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

Sidecar 0.2.8 and later also reconcile on their own: ten seconds after
startup, and then every `NPANEL_RECONCILE_MINUTES` (default 5, `0` disables),
they add any node admin npanel has never seen. That covers keys added before
the mirror existed and keys added while npanel was down, without pressing
**Grant**. The pass never demotes, and leaves a `staff` role for **Grant**. If
an existing admin still shows **No npanel access** after that, the key is not
on the node admin list the panel shows; the sidecar log records
`npanel admins reconciled` with a count when the pass adds any.

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

This is npanel's own NIP-98 host check, not the sidecar's admin sync. It
depends on npanel knowing the node identity, which Compose supplies as
`NCC_PUBKEY` from `NCC_OPERATOR_PUBKEY`; an empty value means NCC URLs are
never accepted, whatever the image version:

~~~sh
sudo docker-compose -p ncc-bundle exec npanel printenv NCC_PUBKEY
~~~

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

### `search-crawler` is unhealthy after an upgrade

`search-crawler` serves its health endpoint from the same Node event loop that
writes the SQLite/FTS index. A first-import burst after a restart can keep that
loop busy long enough that the default 5-second Docker probe reports
`Health check exceeded timeout`, even though the process is alive and still
indexing. The health check now allows 15 seconds and a 90-second start period.

If the container stays unhealthy after that window, check whether it is
actually progressing:

~~~sh
sudo docker stats --no-stream ncc-bundle_search-crawler_1
sudo docker logs --tail 200 ncc-bundle_search-crawler_1
sudo docker-compose -p ncc-bundle exec search-crawler \
  node -e "fetch('http://127.0.0.1:7781/health').then(r=>r.text()).then(console.log).catch(console.error)"
~~~

A large unbounded index makes full-text maintenance slower. Set
`SEARCH_DB_MAX_BYTES` in `.env` to enable LRU pruning, then recreate the search
containers so the crawler migrates to `auto_vacuum` and enforces the ceiling.

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

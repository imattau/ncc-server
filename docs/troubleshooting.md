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

## Onion endpoint does not load

Tor has to bootstrap and publish an onion descriptor. Check the Tor and
sidecar logs:

~~~sh
sudo docker-compose -p ncc-bundle -f compose.yaml logs --tail=100 tor
sudo docker-compose -p ncc-bundle -f compose.yaml logs --tail=100 sidecar
~~~

The standard provisioner enables Tor for the web service and maps onion port 80
to local HTTP port 8080. Check the onion address printed by the provisioner
against the current web locator. Test from the VM:

~~~sh
curl --socks5-hostname 127.0.0.1:9050 -I http://<web-onion-address>.onion/
~~~

Tor can take several minutes to bootstrap or publish a descriptor. Onion
services require no incoming router forward. Keep SOCKS port 9050 and control
port 9051 bound to loopback; never forward them.

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

# Operator guide

> This guide covers the legacy native systemd installation. New deployments
> should use the [Compose installation and deployment guide](deployment-compose.md).

This guide targets a dedicated Debian 12 or Ubuntu Linux host. The installer
replaces the packaged Caddy service's command and serves this site's Caddyfile;
do not use it on a host where `caddy.service` already serves unrelated sites.
RHEL/Fedora is not automated in v0.1.

## Network prerequisites

- Give the host a stable LAN address where possible.
- Forward TCP 8080 from the router to this host. A public endpoint that does not
  reach Caddy is not usable even if it is published correctly.
- Open the port in the host firewall. Examples:

  ```sh
  sudo ufw allow 8080/tcp
  sudo firewall-cmd --permanent --add-port=8080/tcp && sudo firewall-cmd --reload
  ```

- CGNAT prevents ordinary inbound port forwarding. Check the router's WAN IPv4
  address against the public egress address:

  ```sh
  sudo ./scripts/check-nat.sh <router-wan-ipv4>
  ```

  An address in `100.64.0.0/10`, or a router WAN address that differs from the
  public egress address, indicates upstream NAT. The script cannot distinguish
  ordinary router NAT from ISP CGNAT without the router WAN address. Ask the ISP
  for a public IPv4 address or use a separately configured reachable endpoint.

## Install

Build the included MKStack test page before installing from the project root:

```sh
make build-test-app
sudo make install
```

The installer copies `public/` into `/srv/ncc-server/public`. To update the
installed test page later, run `make build-test-app` and `make deploy-test-app`.
The host serves the built files directly; Node is needed only on the build
machine.

The project installer adds `ca-certificates`, `curl`, `gnupg`, `iproute2`,
`rsync`, Git, `patch`, and `openssl`. When Caddy is absent it configures Caddy's signed Debian
repository and installs the package. It then clones the pinned
`nostr-community-conventions` revision and invokes its sidecar installer. To use
a local source checkout instead:

```sh
sudo NCC_SIDECAR_SOURCE=/path/to/nostr-community-conventions/ncc-06/ncc-sidecar make install
```

The install adds:

- Caddy config at `/etc/ncc-server/Caddyfile` and a Caddy systemd drop-in.
- Site files at `/srv/ncc-server/public` (`root:caddy`, directories 0755,
  files 0644).
- Sidecar code at `/opt/ncc-sidecar`, state database at `/var/lib/ncc-sidecar`,
  and a localhost-only admin UI on port 3000.
- A sidecar systemd drop-in for ordering and service hardening.

The installer creates `/var/lib/ncc-sidecar` before invoking the sidecar
installer because the pinned sidecar installer downloads its bundled Node.js
runtime into that directory before creating it itself.

The example env file is installed as `/etc/ncc-server/ncc-server.env` with
`root:root` ownership and mode 0600. It contains only Caddy settings. The
sidecar does not read this file: its signing keys and service configuration are
stored in its database, owned by the `ncc-sidecar` account. The installer now
restricts `/var/lib/ncc-sidecar` to mode 0700 and `sidecar.db` to 0600. This
sidecar version stores signing keys in SQLite and has no systemd credential
input; `systemd-creds` therefore cannot replace its database key storage without
an upstream integration. Protect backups of `/var/lib/ncc-sidecar` accordingly.

## Provision the sidecar

The sidecar UI binds to localhost. For a remote host, forward its port through
SSH from your workstation:

```sh
ssh -L 3000:127.0.0.1:3000 user@server
```

Then visit `http://127.0.0.1:3000` locally. Complete the setup flow with your
admin npub and configure:

1. One service named `web`, service ID `web`, type `custom` (or the equivalent
   generic HTTP service type in the pinned UI).
2. IPv4 enabled, port 8080, with the desired primary address family. Disable
   Tor unless the host has intentionally configured Tor.
3. Service mode `public` for the normal bundle. The sidecar defaults to
   `private`; private mode with no recipient does not publish a locator. Public
   mode explicitly opts out of locator encryption and exposes the endpoint to
   relays. To keep a service unlisted, use `make service-private` (or the
   panel's **Access** dialog) after provisioning; see
   [private services](private-services.md).
4. A publication relay set. The Compose defaults use the tested pair
   `wss://relay.primal.net` and `wss://relay.ditto.pub`.
5. NCC-05 TTL and refresh interval so the refresh interval is shorter than the
   locator TTL. The current sidecar defaults are 12 hours and 6 hours.

Use the sidecar's service controls to force an initial publish after saving the
profile. Confirm the advertised endpoint begins with `http://` and uses port
8080.

## Enable pinned HTTPS

The pinned sidecar generates a self-signed certificate at
`/opt/ncc-sidecar/certs/<record-id>/server.crt` and `server.key`; it derives the
SPKI fingerprint and publishes it as the endpoint's `k`. Caddy must serve that
same certificate for NCC Browser's pin check to pass.

1. Create and publish the `web` service over HTTP once. This makes the sidecar
   generate its certificate. Find its numeric record ID in the sidecar service
   list (it is distinct from service ID `web`).
2. Enable Caddy's HTTPS listener with that record ID:

   ```sh
   sudo make enable-tls SERVICE_RECORD_ID=2
   ```

   The script checks the certificate/key pair, restricts the key to the
   `ncc-sidecar` and `caddy` accounts, validates Caddy's configuration, starts
   HTTPS on port 8443, and performs a local HTTPS request.
3. Edit the `web` service in the sidecar UI: set port 8443, preferred protocol
   `https`, keep public mode, and force a publish. Verify the fresh locator has
   an `https://` endpoint and a `k` fingerprint. HTTP remains available on
   port 8080.
4. Open `ncc://<npub>/web/` in NCC Browser. The browser accepts the self-signed
   certificate only when its SPKI fingerprint matches the signed locator.

Allow TCP 8443 through the firewall and forward it through the router. To
return to HTTP, change the sidecar service to port 8080 and protocol `http`,
force a publish, then run `sudo make disable-tls`.

After rotating the sidecar certificate, run `make enable-tls` again for the
same record ID to reload Caddy, then force a locator publish and verify the new
`k` before relying on the endpoint.

## Enable an onion endpoint

Tor is optional. It does not need inbound router forwarding: the VM makes
outbound Tor connections, and clients reach the service through the Tor
network. Keep TCP 9050 (SOCKS) and 9051 (control) bound to loopback; do not
forward either port from the router. Continue forwarding 8080 and 8443 for the
public clearnet endpoints.

The Compose bundle enables Tor for every public service during first-run
provisioning, so each of `web`, `relay`, `npanel`, `ditto`, `search` and
`admin` publishes its own onion endpoint. `addr` serves the same page as
`web`, so it advertises web's onion instead of creating a second address. The
relay onion maps onion port 80 to its loopback backend on 13131; the others
map to the loopback HTTP listeners in `container/Caddyfile`. A custom service
installed with `make service-add` gets its own onion automatically, mapped to
its loopback backend port. On an existing Compose install, deploy the release,
recreate `caddy`, then run:

```sh
sudo make bundle-enable-tor
```

That merges Tor settings into the existing records without changing their
profiles, relays or cadence, then republishes. Confirm every service shows an
onion address in the sidecar UI or from service provisioning.

For a native install of the web service and its HTTP listener on 8080, enable
Tor for its numeric sidecar record ID:

```sh
sudo make enable-tor SERVICE_RECORD_ID=2 TOR_TARGET_PORT=8080
```

The command installs Debian's Tor package, configures a password-authenticated
control port on `127.0.0.1:9051`, writes the generated control password only to
the sidecar's local database, enables the Tor protocol on the selected service,
maps onion port 80 to the selected local HTTP port, and asks the sidecar to
republish. It leaves the public HTTPS endpoint on 8443 intact. Run it again
with another record ID and that service's loopback HTTP target to give that
service its own onion. The project installer applies a small pinned-source
patch so the sidecar does not write the Tor control password or onion private
key into its journal.

Check `systemctl status tor@default ncc-sidecar`, then verify the service
record's Tor status and onion address in the sidecar. The published Kind 30058
locator should retain the HTTPS endpoint and add an `http://<address>.onion/`
endpoint. A successful Tor bootstrap and relay publish confirm setup, but a
real client check is the final test:

```sh
curl --socks5-hostname 127.0.0.1:9050 -I http://<address>.onion/
```

This request can take a few minutes while Tor bootstraps and publishes the
onion descriptor. Confirm the response is HTTP 200 and the address resolves
from a separate Tor client where possible. Do not test by exposing port 9051.

## Operate

```sh
systemctl status caddy ncc-sidecar
journalctl -u caddy -u ncc-sidecar -f
make status
make logs
```

Edit `/etc/ncc-server/ncc-server.env` to change the content port/root, then
restart `caddy.service`. The sidecar's service profile must be changed to match
the advertised port and endpoint. Place or update content in
`/srv/ncc-server/public`; Caddy serves it without a restart.

Verify the locator from this checkout:

```sh
make verify NPUB=npub1... SERVICE=web
```

The verifier queries the configured relays, checks the event signature, kind,
author, `d` tag, public JSON payload, endpoints, and freshness. Finally, open
`ncc://<npub>/web/` in `ncc-browser` and test from outside the host's LAN.

## Remove

`sudo make uninstall` disables the sidecar, removes this project's drop-ins and
installed Caddyfile, then restarts the packaged Caddy service with its original
configuration. It keeps site content and sidecar data. To
remove the sidecar code, database, and unit as well, use the pinned sidecar
installer's `remove` command after backing up anything needed. That command
deletes its data directory.

## Security notes

- The nsec is managed by the sidecar and stored in its SQLite database; it is
  not in the project env file. Restrict access to the database and its backups.
- Public locator records disclose endpoint metadata by design. Do not publish a
  private or administrative endpoint this way. A private service encrypts the
  locator but still leaves its port reachable; private is unlisting, not access
  control. See [private services](private-services.md).
- Keep the sidecar admin API on localhost. Do not pass its installer's
  `--allow-remote` option or expose port 3000 through the firewall.
- Use only one service profile in v0.1. Multi-service publishing and NIP-46
  administration are outside this project version.


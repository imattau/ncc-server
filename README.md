# NCC-Server

A Linux host stack for serving a static site and publishing its current locator on
Nostr. Caddy serves the site; the existing NCC-06 sidecar maintains NCC-02/NCC-05
records. This project contains no locator publisher.

v0.1 targets Debian 12/Ubuntu with Caddy's packaged `caddy.service` and the
sidecar's installer-generated `ncc-sidecar.service`. The sidecar's admin UI stays
on localhost. Initial service provisioning is completed in that UI.

> **Public locator:** this setup deliberately opts out of NCC-05 locator
> encryption so clients can resolve the site by npub without a signer. Relays
> can read the published endpoint. Use it only for an intentionally public
> endpoint whose metadata disclosure is acceptable.

## Quick start

1. Ensure the host has network access to Debian package mirrors, the Caddy
   package repository, and GitHub. The machine building the test page needs
   Node.js 22+; the host does not need Node.js.
2. From this checkout, run `make init-test-identity` once to create a reusable
   host-only test keypair, then run `make build-test-app` to build the MKStack
   test page into `public/`. Then run `sudo make install`. The installer installs Git,
   Caddy, curl, certificates, and iproute2, then creates
   `/etc/ncc-server/ncc-server.env` from the example if it does not exist,
   installs the sidecar at its pinned source revision, and enables both services.
3. Complete sidecar setup at `http://127.0.0.1:3000` using an SSH tunnel if the
   host is remote. Add one public `custom` service with ID `web`, port `8080`,
   IPv4 enabled, and a public locator. Configure the relay list and disable
   Tor unless it is intentionally being used.
4. Put site files in `/srv/ncc-server/public`. The MKStack test page is installed
   on a fresh host. Forward TCP 8080 through the router and firewall. To refresh
   the installed test app after editing it, run `make build-test-app` followed
   by `make deploy-test-app`.
5. Open the host in a browser; the test page checks HTTP response and can query
   relays to verify the service locator. Run `make verify NPUB=<npub> SERVICE=web`
   to check the locator from the command line and open
   `ncc://<npub>/web/` in `ncc-browser`.

The exact sidecar UI labels and the resulting endpoint inventory must be checked
against the pinned release during the M0 verification. See
[`docs/schema-verification.md`](docs/schema-verification.md).

## Operations

```sh
make status
make logs
make verify NPUB=npub1... SERVICE=web
sudo make uninstall
```

Use `systemctl status caddy ncc-sidecar` and `journalctl -u caddy -u ncc-sidecar`
for the standard Linux operations surface. See the [operator guide](docs/operator.md)
and [troubleshooting](docs/troubleshooting.md).

The MKStack source project is in [`test-app/`](test-app/). Its built static
output is staged in `public/` for Caddy, so the production host does not need
Node.js. The generated service test keypair stays under the test app's
Git-ignored `.secrets/` directory on the host. For an isolated VM test, use
`NCC_TEST_ENDPOINT=http://<vm-address>:8080 make publish-test-locator` on the
host; the private key is not copied into the VM. For a pinned HTTPS fixture,
also set `NCC_TEST_K=<43-character-SPKI-fingerprint>`.

## Project status

The installer pins sidecar source commit
`186c3ad50966a2319c354ace12e0a5a2267b75d9` and applies a small compatibility
patch so it waits for matching positive relay acknowledgements for every event
in a publish batch. It fails closed if the pinned publisher source has changed.
M0 toolchain and external reachability checks passed. NCC Browser has resolved
both the host-published fixture and an actual locator emitted by the VM sidecar;
independent external checks also returned HTTP 200 from both forwarded ports.
The current public locator resolves to `https://1.43.63.94:8443/`; see
[`docs/schema-verification.md`](docs/schema-verification.md).

M1 port-change republishing passed when Caddy and the sidecar profile were
updated together: the sidecar published a fresh locator for port 8444 without
a manual publish call, and Primal verification confirmed the endpoint. The
sidecar profile must be updated to match the Caddy listener; automatic IP-change
republishing has not passed.

M3 adds an optional pinned HTTPS listener that shares the sidecar-generated
self-signed certificate with Caddy. Local TLS, matching-pin acceptance,
mismatched-pin rejection, certificate rotation, service recovery, and the VM
smoke check passed. HTTPS is externally reachable through the router forward.
A VM interface-address-change probe republished the old configured endpoint,
so automatic IP-change republishing is not verified. The 72-hour soak remains.
Sidecar signing keys remain in its SQLite database with restrictive file
permissions because this pinned release has no systemd credential input. See
[`docs/schema-verification.md`](docs/schema-verification.md) for the test result.


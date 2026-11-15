# Podman alternative (not the primary deployment)

The supported path is the Docker Compose bundle documented in
[`deployment-compose.md`](deployment-compose.md). Podman is an optional,
operator-maintained alternative.

Any Podman deployment of the sidecar must use host networking; bridge networking
can hide the host's usable interface addresses and produce incorrect locator
endpoints. Keep its admin UI bound to `127.0.0.1:3000`, persist the sidecar
database and certificate directory, and keep Caddy bound to the chosen content
port. Do not publish the nsec into an image or compose file. Use Podman's secret
or a root-owned runtime secret file if the container setup requires an explicit
key.

This alternative has not been implemented or tested in v0.1. Use it only after
the native M0 contract and locator behavior are verified.

The Ditto Relay integration test uses its own upstream Compose stack; it does
not bundle the relay into the NCC sidecar container. See
[`ditto-relay.md`](ditto-relay.md) for the current network, secret, and data
boundaries to preserve when a later Podman bundle is designed.

## Planned bundle services

The later Podman bundle is intended to include the NCC sidecar, Caddy, Ditto
Relay with its private OpenSearch dependency, and [npanel](https://soapbox.pub/npanel).
This is a design target; no combined Podman bundle exists or has been tested yet.

Npanel is a multi-host nsite gateway, not a dashboard that can be mounted below
a path on the existing test site. The intended NCC entry point is a service
locator addressed by the bundle's npub and an Npanel service ID. Npanel itself
does not need to implement NCC merely to sit behind that locator: the NCC
sidecar publishes the endpoint, and shared Caddy routes it to Npanel. Its
documented settings include
`DASHBOARD_HOST`, an HTTP `PORT` (80), `TLS_CHECK_PORT` (3001), and a persistent
`DATA_DIR` for SQLite and cached site files. Leave Npanel's own HTTPS listener
disabled when using the bundle's shared Caddy. The upstream setup starts its own
Caddy container; the bundle must omit that proxy and route dashboard and
wildcard site hosts through the shared Caddy to Npanel. Preserve the existing
dedicated WSS route for Ditto Relay and its NCC locator certificate/pin.

The dashboard's NCC service path and root-relative assets were tested in the
Debian VM; see the result below. A dedicated Npanel locator can route to Npanel
without an upstream fork. Serving arbitrary nsite domains through NCC remains
separate: Npanel selects sites by HTTP hostname, so test whether the existing
NCC URI and resolver carry a usable site hostname before deciding whether an
adapter or upstream change is needed. Do not assume that publishing one
Npanel locator automatically makes every hosted domain available through NCC.

The bundle must persist Npanel's data directory independently of the image and
make its configured relays and Blossom servers operator-configurable. Npanel
supports changing those in its dashboard without a restart. Its first admin
must be provisioned from the intended operator's npub using Npanel's
`make-admin` command; do not bake an admin secret into the image or compose file.
Give Npanel a distinct HTTP host and route on the shared listener: the existing
web and onion locators share the IP/onion host and must continue serving the
static app. The sidecar's Npanel endpoint is set manually to that dashboard
host, and Caddy dispatches by `Host` while defaulting to the static site.

Before implementing the bundle, choose a dashboard domain and a wildcard domain
for nsites, point both (including the wildcard record) at the host, and confirm
the router/firewall can accept public HTTP and HTTPS for those names. Those
domains are needed for Npanel's normal web entry points even when NCC is the
discovery path. For public
TLS, use a trusted certificate path in shared Caddy. The current IP-based
self-signed test endpoints are not suitable for this gateway's domain routing
or ordinary browser trust. Size the combined stack with the existing 4 GiB VM
in mind: Ditto's documented test stack alone assigns OpenSearch a 1 GiB heap,
and Npanel also keeps downloaded site files on disk.

## Npanel NCC URI test (2026-11-15)

Npanel 0.7.2 was installed in the Debian test VM from Soapbox's signed stable
Debian repository. This is a VM integration test, not the future Podman bundle.
Npanel runs as its own systemd service on loopback port 3200 with dashboard host
`1.43.63.94`; its SQLite database and blob store use `/var/lib/npanel`. The
existing test identity npub was made an Npanel admin; its private key remains
on the host.

The sidecar created public service record 4 (`service_id=npanel`) with service
npub `npub14sctg7f3dh8cmqmfkynkfuevfafrl7ll4pnf3mcu4jprcmtg9mdsqfn8vz`. Its
fresh, signed `npanel-locator` was verified from Primal and Ditto and advertises
`http://1.43.63.94:8080`. Caddy routes that HTTP listener to Npanel; Ditto WSS
remains on 8444.

The actual Nostr Navigator app opened
`ncc://npub14sctg7f3dh8cmqmfkynkfuevfafrl7ll4pnf3mcu4jprcmtg9mdsqfn8vz/npanel/`.
It resolved the fresh locator and rendered Npanel's dashboard page at the
internal `/_/npanel/` path. The page's root-relative JavaScript requests also
loaded successfully through NCC. This confirms Npanel's dashboard works as an
NCC service without a fork. The browser was unsigned, so this verified the
landing page and not admin sign-in.

### NCC nsite route test

The `npanel-ncc` fork adds `/nsite/<npub-or-naddr>/…` routing, selecting the
enabled Npanel site by its NCC identifier. On the VM, Caddy's existing TLS
listener on port 8443 now proxies `/nsite/*` to Npanel on loopback port 3200;
other HTTPS paths continue to serve the test app. Npanel itself listens on HTTP
only. The TLS certificate is the sidecar-generated self-signed certificate
already configured for Caddy, and the locator advertises its matching SPKI pin.

A fresh profile of Nostr Navigator resolved
`ncc://npub1asy6ca3ppxa70e6z7lpm2d4tuh09sh3x5cg4485f0juwgvxm77kq6pl8fr/nsite-test/`
from the signed `nsite-test` locator and rendered “NCC nsite served”. Its
root-relative `/app.js` also loaded and marked the page probe as `loaded`.
The locator advertised `https://1.43.63.94:8443/nsite/npub1asy6ca3ppxa70e6z7lpm2d4tuh09sh3x5cg4485f0juwgvxm77kq6pl8fr/`
with the matching `k` pin and was acknowledged by Ditto and Primal. It expires
after 24 hours. The router already forwards 8443, so no additional port is
needed for this test.


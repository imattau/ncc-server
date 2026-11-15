# Ditto Relay integration test

This test adds Ditto Relay as a second NCC service beside the existing `web`
service. The Debian VM runs Ditto Relay and OpenSearch from the upstream
Compose file. Caddy terminates TLS on TCP 8444 and forwards WebSocket traffic
to the relay on loopback TCP 13131. OpenSearch is private to the Compose
network, and the relay's unencrypted listener is bound to loopback.
Upstream documents its Compose stack, required relay key, private OpenSearch
network, and reverse-proxy TLS setup in the [Ditto Relay README](https://gitlab.com/soapbox-pub/ditto-relay/-/raw/main/README.md).

The test uses a self-signed certificate. The included Node test client opts out
of certificate verification for that process only. This checks WSS transport
and the NIP-01 request/response flow; it does not establish ordinary-client
certificate trust.

## Provision and start

Create the second NCC service record and its private relay runtime environment:

```sh
sudo make provision-ditto-relay RELAY_URL=wss://1.43.63.94:8444/
```

The script creates an active service with ID `relay`, generates an independent
relay signing key, stores it under `/etc/ncc-server/ditto-relay.env` with mode
0600, and forces locator publication. It uses the existing public publication
relays, including `relay.ditto.pub`. The service's locator key is managed by
the sidecar database, separate from Ditto's signing key.

Install Docker Engine and Compose, clone Ditto Relay, and start its upstream
relay/OpenSearch stack:

```sh
sudo make install-ditto-relay
```

The install records the checked-out upstream commit in
`/etc/ncc-server/ditto-relay.revision`. Relay events persist in the Compose
`opensearch-data` volume. The runtime secret remains outside the checkout; the
checkout's `.env` is a root-owned symlink to the private environment file.

After provisioning, the sidecar prints the relay service's numeric record ID.
Use it to serve that record's certificate through Caddy:

```sh
sudo make enable-relay-proxy SERVICE_RECORD_ID=<numeric-record-id>
```

The proxy requires Ditto to be healthy on `127.0.0.1:13131` and uses the
certificate generated for the relay record. The web service keeps its existing
port 8443 listener and locator.

## Network and verification

If a host firewall is active, allow TCP 8444. The router rule for external
testing is **TCP 8444 to VM `192.168.86.249:8444`**. No forwarding is needed for
the relay backend on 13131 or OpenSearch on 9200.

Run the WSS test from a machine with Node.js 22 or newer:

```sh
make test-ditto-wss RELAY_URL=wss://1.43.63.94:8444/
```

It connects over WSS, sends an NIP-01 `REQ`, and requires the matching `EOSE`.
The test disables TLS certificate validation only in this child process.
Check the locator records separately with:

```sh
make verify NPUB=<relay-service-npub> SERVICE=relay
make verify NPUB=<existing-web-npub> SERVICE=web
```

Ditto serves NIP-11 on the same address:

```sh
curl --insecure --header 'Accept: application/nostr+json' https://1.43.63.94:8444/
```

Inspect the stack with `docker-compose -p ditto-relay -f /opt/ditto-relay/source/docker-compose.yml ps`
and `docker-compose -p ditto-relay -f /opt/ditto-relay/source/docker-compose.yml logs --tail=100`.
OpenSearch's default heap is 1 GiB; the VM has 4 GiB RAM, so this is a light
integration test rather than a production sizing profile.
The Debian 12 Compose v1 package does not support the upstream top-level
`name` field; the installer removes that field in its local checkout and sets
the same project name with `-p ditto-relay`.

## Later Podman integration

This test keeps the upstream relay stack separate from the NCC host services.
The relay image can later become a Podman-managed component while preserving
these boundaries: WSS terminates at Caddy, the relay backend remains
loopback-only, OpenSearch remains private, and event data and relay secrets
remain persistent runtime state outside the image. Do not bake the secret or
OpenSearch data into a future image.

## Test result (2026-11-15)

- **Multiple locators: PASS.** Sidecar record 3 publishes service ID `relay`
  under `npub1cx7yls8cgc0fv9yf2kf45lfqy9zar89ljdwafn2tpm2qtya6qmzspl6eje`.
  Fresh `relay-locator` and `web-locator` events both verified from Primal and
  Ditto; the web locator still advertises HTTPS 8443 and its onion endpoint.
- **WSS and restart: PASS locally.** The relay returned NIP-11 HTTP 200 and a
  NIP-01 `REQ`/`EOSE` exchange over WSS through a temporary SSH tunnel. The
  same checks passed after restarting Caddy and the relay container. The relay
  locator's TLS pin matches the certificate Caddy serves.
- **Compose and isolation: PASS.** Upstream revision
  `e8974053dcf99ac952d1951deaffec105aeb08f1`; OpenSearch and relay health
  checks are green. Relay plaintext is bound to `127.0.0.1:13131`, and the
  signing environment file is root-owned mode 0600.
- **External WSS reachability: PASS.** After forwarding TCP 8444 to VM
  `192.168.86.249:8444`, the public WSS `REQ`/`EOSE` check passed. Public
  HTTP 8080, HTTPS 8443, and relay NIP-11 on 8444 all returned HTTP 200.

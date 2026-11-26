# Ditto web client test

The Compose bundle uses the published `ncc-server-ditto-web` image, built from
the `imattau/ditto` fork at the revision pinned by the release workflow. The
pin is a commit on the fork's `ncc-web` integration branch, which carries the
web-specific NCC changes; the native transport branch is separate. It
serves the Vite output from an unprivileged Nginx container. The build uses
[`ncc-router-basename.mjs`](../container/ditto-web/ncc-router-basename.mjs) to
apply a fail-closed compatibility edit: NCC Browser preserves `/_/<service>` in
the secure page path, and Ditto's React router needs that prefix as its basename
to render the service root. The edit is applied only in the container build;
the fork checkout stays unchanged. The container is reachable only through
Caddy. Set
`DITTO_WEB_HOST` to a hostname routed to this VM; the default test value uses
the public IP's `nip.io` hostname.

The test locator uses service ID `ditto`, a public endpoint at
`https://<DITTO_WEB_HOST>:8446/`, and the SPKI pin from the existing Caddy web
certificate. The web endpoint and HTTPS route are distinct from the primary
test app and Npanel dashboard.

The Debian 12 VM test locator is
`npub1fkpp9p4m04knz6mafnsqhuvhn6cjrkqe8ffyfs2qmgq8ufx6k64qr9p9zh`. Its
fresh `ditto-locator` event was verified on `wss://relay.primal.net` and
contains the expected HTTPS endpoint and SPKI pin.

## Build and run

```sh
docker-compose -p ncc-bundle -f compose.yaml pull ditto-web
docker-compose -p ncc-bundle -f compose.yaml up -d ditto-web caddy
```

Then configure or update the locator from a host with local access to the
sidecar admin API:

```sh
DITTO_WEB_HOST=ditto.1.43.63.94.nip.io \
DITTO_WEB_K=<existing-Caddy-SPKI-pin> \
node scripts/configure-ditto-web.mjs
```

The script is idempotent for an existing service ID. It prints a new npub only
when it creates the service; it never prints the private key. It republishes
all active sidecar records because that sidecar version has a service-wide
manual republish endpoint.

Check `https://<DITTO_WEB_HOST>:8446/` in a browser and resolve
`ncc://<ditto-npub>/ditto/` in NCC Browser. Check the signed event's endpoint
and `k` pin with the project's locator verification tools. The current VM test
was also loaded in NCC Browser; its Ditto home screen rendered successfully.

## Profile website links

The profile `website` field accepts the usual `https://` address, plus the two
address families NCC Browser understands:

- `ncc://<npub>/<service>` — an NCC service identity, resolved by NCC Browser
  through its signed locator. `ncc://<npub>` means the default `addr` service.
- `nsite://<npub>[/<site>][/path]` — a NIP-5A static site. Ditto's host form,
  `nsite://<npub>`, `nsite://<base36-pubkey><site>`, and
  `nsite://v<base36-snapshot-id>`, is also accepted.

Inside NCC Browser the original `ncc://` / `nsite://` address is used, so the
browser opens the service or site natively with any path intact. In an ordinary
web page, Ditto opens a linked nsite in its own viewer at the site root; an
`ncc://` link needs NCC Browser to resolve it. Bare hostnames are still
normalised to `https://` as before. Malformed or unsupported schemes are not
rendered as links.

## NCC links in posts

A standalone `ncc://<npub>/<service>` link in a post, quote, or embedded note
renders an NCC service card. The card reads the public kind `30059` anchor and
shows the service name, shortened address, `Public` / `Private` / `Expired`
state, and the public endpoint host when one is published. It does not contact
the service endpoint. Inside NCC Browser the card offers **Open**; in an
ordinary browser it offers **Copy address**. If the anchor is not on the
configured relays, the card falls back to the address alone.

This is not an OpenGraph preview: title, description, and image require a
later NCC Browser preview endpoint that resolves the service page.

## Scope

This verifies the fork's browser build, Caddy routing, and NCC locator. The
fork's native Android/iOS WebSocket transport with certificate pinning is
selected only in a native Capacitor runtime, so it cannot be exercised by this
web container. That path needs a separate native build and device/emulator
test. Keep the fork revision pinned until its NCC modifications land upstream.

# Hello Service

A minimal NCC service example. It is a zero-dependency Node HTTP server that
demonstrates the container contract:

- listens on `0.0.0.0:8080`
- serves plain HTTP; Caddy terminates TLS
- runs as the non-root `node` user
- writes nothing to disk, so a read-only root filesystem is fine
- exposes `/healthz` for the NCC probe
- reads its configuration from environment variables

Replace `server.mjs` and `Dockerfile` with your application; keep the same
service contract.

## Run locally

```sh
docker build -t hello-service:dev .
docker run --rm --read-only --tmpfs /tmp -p 127.0.0.1:18080:8080 hello-service:dev
curl http://127.0.0.1:18080/healthz
```

## Install on an NCC node

From the `ncc-server` checkout on the node:

```sh
sudo make service-add PACKAGE=/path/to/hello-service
```

The service becomes available at `ncc://<operator-npub>/hello/`. Use
`make service-check PACKAGE=/path/to/hello-service` before installing.

To upgrade an installed copy:

```sh
sudo make service-upgrade PACKAGE=/path/to/hello-service
```

Roll back the last upgrade with:

```sh
sudo make service-rollback SERVICE=hello
```

Remove it with:

```sh
sudo make service-remove SERVICE=hello
```

## Build and publish from this repository

The workflow in `.github/workflows/publish.yml` builds and pushes
`ghcr.io/<owner>/<repo>` and then publishes a signed npack descriptor. Set:

- repository variable `NCC_PUBLISHER` to the publisher npub
- repository secret `NOSTR_SECRET_KEY` to the publisher secret key

Without `NOSTR_SECRET_KEY`, the package is built as a workflow artifact but is
not published to relays or Blossom.

The image must be public for other nodes to pull it anonymously. The workflow
pins the pushed digest in the descriptor.

## Publish manually

```sh
python3 /path/to/ncc-server/scripts/npack-service.py build \
  --service-dir . \
  --version 1.0.0 \
  --publisher npub1... \
  --image ghcr.io/acme/hello-service:1.0.0 \
  --output ./hello-service-1.0.0.npk

python3 /path/to/ncc-server/scripts/npack-service.py publish \
  --manifest ./hello-service-1.0.0.manifest.json \
  --secret-key "$NOSTR_SECRET_KEY" \
  --relay wss://relay.damus.io \
  --server https://blossom.primal.net
```

See [Build an NCC service](../../docs/build-a-service.md) for the full
walkthrough.

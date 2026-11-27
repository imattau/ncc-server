# Add a custom Compose service

New to running your own app? Start with
[Build an NCC service](build-a-service.md), which includes a working example,
a scaffold command, and local validation.

The bundle includes a starter package at
`templates/custom-compose-service`. Copy it to a working directory, change
`service.json` and `compose.yaml` for the application, then install it on the
server:

```sh
sudo make service-add PACKAGE=/path/to/your-service-package
```

This page describes an **operator-authored** package: you write the Compose
fragment yourself and install it from a path on the host. To distribute a
service to other nodes, publish it as a signed npack package instead; the node
then generates the Compose fragment from the descriptor and will not accept
publisher-supplied Compose text. See [npack services](npack-services.md).

The package has two files:

- `service.json` describes the NCC service ID and name, the Compose service
  key and image, public TLS port, loopback backend port, container port, and
  health probe path.
- `compose.yaml` describes the container. Keep the service key aligned with
  `compose_service` and keep the loopback-only host port mapping shown in the
  template. Add the application's environment, volumes, health check, and
  other container settings as needed.

The command copies the package into `custom-services/packages/<service-id>`,
fetches the image with Compose, starts the container, waits for its backend,
creates the custom service record in the local NCC sidecar, writes
a dedicated Caddy TLS listener, reloads Caddy, and publishes the locator. It
uses the existing operator identity and the bundle's web certificate, so the
locator pin matches the certificate Caddy presents. The service becomes
available at `ncc://<operator-npub>/<service-id>/`.

Custom Compose fragments are included by `make bundle-up`, `make bundle-down`,
`make bundle-pull`, `make bundle-config`, and the stack status check. Containers
use `restart: unless-stopped`, so they also start after a host reboot. The
custom route and package files live under `custom-services/`; back up that
directory with the bundle configuration.

Choose ports that are not already in use. The command rejects the bundle's
reserved ports and checks that the selected public and backend ports are free.
The public TLS port must also be allowed through the server firewall and
forwarded through the router for internet access. The backend port binds only
to loopback and should not be exposed publicly. The NCC sidecar admin API
remains bound to localhost.

This first version is for HTTP services with one Compose service and one
backend port. Apps that require additional public origins, multiple public
ports, or special TLS behavior need additional Caddy and locator
configuration. Caddy's reverse proxy passes WebSocket upgrades, so a normal
WebSocket app does not need a separate configuration, but it still uses the
same single HTTP port.

## Updating and removing

Validate a package before installing it:

```sh
make service-check PACKAGE=/path/to/package
```

Preview the install without changing the node:

```sh
sudo make service-add PACKAGE=/path/to/package DRY_RUN=1
```

Replace an installed package:

```sh
sudo make service-upgrade PACKAGE=/path/to/package
```

The previous package is kept under
`custom-services/packages/.previous/<service-id>`. Restore it with:

```sh
sudo make service-rollback SERVICE=<service-id>
```

Remove a service:

```sh
sudo make service-remove SERVICE=<service-id>
sudo make service-remove SERVICE=<service-id> PURGE=1
```

The container, Caddy route, sidecar record, and staged package are removed.
Named volumes are kept unless `PURGE=1` is set. The last published locator
remains on relays until its TTL expires.

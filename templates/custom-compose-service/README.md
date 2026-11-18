# Custom NCC Compose service template

Copy this directory, edit `service.json`, and adapt `compose.yaml` for the
service image. Then install it from the NCC-Server checkout on the server:

```sh
sudo make service-add PACKAGE=/path/to/your-service
```

The package must contain `service.json` and `compose.yaml`. Keep one Compose
service whose key matches `compose_service`. Its image should be the image
named by `image`; the template uses the provided environment variables to map
the loopback-only host `backend_port` to `container_port`. The image is pulled
before the container starts. You can replace the health check and other
container settings to match your app, but keep the loopback-only port mapping.

Choose a unique lower-case `service_id` (letters, digits, and hyphens), a free
public TLS port, and a free loopback backend port. NCC-Server uses the existing
operator identity and web certificate. It creates the sidecar service record,
configures Caddy to proxy the public TLS port to the backend, and publishes a
signed locator with the matching certificate fingerprint.

The service also gets its own Tor onion endpoint automatically. The onion maps
onion port 80 to the loopback backend port, so the backend must answer plain
HTTP on that port (the template already does). Tor settings are merged into
the new record without changing the rest of its configuration.

The installed record also stores the package's `compose_service` as
`compose_services`, so the admin panel's Restart and container-log actions
work for the new service without another mapping step.

The public TLS port must be allowed through the host firewall and forwarded
through the router if the service should be reachable from the internet. The
sidecar admin API remains local and is never exposed by this package.

# Custom NCC Compose service template

Copy this directory, edit `service.json`, and adapt `compose.yaml` for the
service image. Then install it from the NCC-Server checkout on the server:

```sh
sudo make service-add PACKAGE=/path/to/your-service
```

The package must contain `service.json` and `compose.yaml`. Keep one Compose
service whose key matches `compose_service`, and make that key unique across
all installed packages. Its image should be the image named by `image`; the
template uses the provided environment variables to map the loopback-only host
`backend_port` to `container_port`. The image is pulled before the container
starts. You can replace the health check and other container settings to match
your app, but keep the loopback-only port mapping.

The template uses the unprivileged nginx image because the generated container
runs with a read-only root filesystem. The image writes its pid and cache files
under `/tmp`, which is mounted as tmpfs. If you use another image, make sure
its writable directories are `/tmp` or are mounted explicitly; otherwise the
container exits at startup with a read-only filesystem error. Running as
non-root (`user:`) is strongly recommended.

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

This template is for an operator-authored local package. To distribute the
service to other nodes, publish it as a signed npack descriptor instead: see
[docs/npack-services.md](../../docs/npack-services.md) and
`templates/ncc-service-npk/`. For a complete buildable example, see
[`examples/hello-service`](../../examples/hello-service) and the
[service quickstart](../../docs/build-a-service.md).

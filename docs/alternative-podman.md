# Podman alternative (not the v0.1 primary path)

The supported path is native systemd. Container deployment is a later,
operator-maintained alternative because the sidecar needs visibility into host
interfaces and its installer is designed to create a systemd service.

Any Podman deployment of the sidecar must use host networking; bridge networking
can hide the host's usable interface addresses and produce incorrect locator
endpoints. Keep its admin UI bound to `127.0.0.1:3000`, persist the sidecar
database and certificate directory, and keep Caddy bound to the chosen content
port. Do not publish the nsec into an image or compose file. Use Podman's secret
or a root-owned runtime secret file if the container setup requires an explicit
key.

This alternative has not been implemented or tested in v0.1. Use it only after
the native M0 contract and locator behavior are verified.


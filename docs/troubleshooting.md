# Troubleshooting

## Check services and logs

```sh
systemctl status caddy ncc-sidecar --no-pager
journalctl -u caddy -u ncc-sidecar --since '30 minutes ago'
systemctl cat caddy
systemctl cat ncc-sidecar
```

## Site does not load on the host

- Confirm `/etc/ncc-server/ncc-server.env` has `CONTENT_PORT=8080` and the
  matching root directory.
- Check `curl -v http://127.0.0.1:8080/` and inspect Caddy's journal.
- Check file permissions: directories should be searchable by `caddy`, files
  readable, and the content tree should remain `root:caddy`.
- If another service already owns port 8080, choose an unused port and update
  both the env file and sidecar service profile.

## Site loads locally but not remotely

- Check the host firewall and router TCP port-forward to the host's LAN address.
- Run `scripts/check-nat.sh <router-wan-ipv4>`. CGNAT or upstream NAT blocks
  ordinary port forwarding.
- Test from a second network; loopback and same-LAN success do not prove public
  reachability.

## No locator or a stale locator

- Ensure the sidecar is initialized, the web profile is active, and public mode
  is selected. Its default is private, which will not publish without recipients.
- Confirm publication relays are configured and reachable in the sidecar UI.
- Force one publish and inspect `journalctl -u ncc-sidecar` and the sidecar UI
  logs for relay results.
- Run `make verify NPUB=<npub> SERVICE=web`; confirm `d=web-locator`, endpoint
  port, and freshness.
- Keep the refresh interval below the TTL. A locator that expires before its
  next refresh will disappear from normal resolution.

## Published endpoint is wrong

- Confirm the sidecar service is configured as a generic web/custom service,
  with port 8080 and IPv4 enabled.
- Compare the advertised URL to the host's actual public address and verify the
  router forwards that port to this host.
- When changing Caddy's port, update the sidecar service profile's port and
  endpoint to match. The manager republishes after that profile change, but it
  does not infer an arbitrary Caddy listener change.
- Public-IP changes are not verified for this deployment. After an address
  change, inspect the next signed relay event and confirm the endpoint actually
  changed before relying on it; a successful publish response alone is not
  sufficient.

## Sidecar fails after hardening

Inspect the unit and journal. The drop-in allows AF_NETLINK for interface
enumeration and writable paths for the database and generated certificates. If
the pinned sidecar uses another runtime write path, add only that path to
`ReadWritePaths` and record the reason here; do not remove the sandbox wholesale.


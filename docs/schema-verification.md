# Sidecar and locator verification (M0)

## Source inspected

The implementation below was reviewed in the workspace at commit
`186c3ad50966a2319c354ace12e0a5a2267b75d9` (sidecar package `1.2.2`), including
`ncc-06/ncc-sidecar/src/config.js`, `builder.js`, `services/registry.js`,
`app.js`, `inventory.js`, and `scripts/install-sidecar.sh`.

## Config and unit facts

- The production installer creates `ncc-sidecar.service`, runs as the
  `ncc-sidecar` system user, sets `NCC_SIDECAR_DB_PATH`, `ADMIN_PORT`, and
  `ADMIN_HOST=127.0.0.1`, and uses `Type=simple` with restart-on-failure.
- It does not load an `EnvironmentFile`, include ordering after Caddy, or set
  systemd hardening. This project adds a drop-in for ordering and hardening.
- The tested base unit is installer-generated. The project drop-in adds
  `After=network-online.target caddy.service`, a restricted address-family set
  including `AF_NETLINK`, filesystem write paths, and the remaining systemd
  hardening controls. `MemoryDenyWriteExecute` is intentionally omitted because
  Node/V8 crashed with `SIGTRAP` when it was enabled.
- Provisioning is via the sidecar's web UI and SQLite database. Service private
  keys are stored in the database. `SERVICE_NSEC`/`config.json` are inputs to
  the separate config loader, not the database-backed production install flow.
- Admin setup defaults `service_mode` to `private`; a public locator requires
  explicitly setting public mode. Private mode without recipients suppresses
  publication.

## Source-derived event shape

For the NCC-05 locator, the sidecar constructs a replaceable event with:

- `kind: 30058`, author equal to the configured service key, and `d` equal to
  `<service_id>-locator` (for this project: `web-locator`).
- An `expiration` tag computed as event creation time plus the configured TTL.
- Plain JSON content produced by `buildLocatorPayload`: `ttl`, `updated_at`, and
  `endpoints[]`. Endpoint records are normalized from discovered inventory and
  include URL, protocol, family, priority, and optional key metadata.
- In private mode, encrypted publication is used for configured recipients; the
  browser's public-only resolver cannot consume those events.

The client resolver currently probes `web`, `web-locator`, then `addr`. It
requires a valid signature and a fresh locator. The project verifier follows
those checks for the public record.

## Debian 12 and relay checks

Status: **PARTIAL — real Debian and relay checks passed; M0 remains open.**

- Fresh Debian 12 VM install completed using the sidecar installer and this
  project's Caddy and sidecar drop-ins. Both units were active and the local
  smoke test passed.
- Provisioned a public `custom` service with ID `web`, port 8080, and IPv4.
  The endpoint inventory published `http://1.43.63.94:8080` (the VM's observed
  public egress IP).
- Relay test: the pinned sidecar publisher sent multiple events and treated the
  first `OK` as success, closing before all event acknowledgements arrived. A
  local install-time patch now waits for each matching event ID's positive
  `OK`, rejects negative acknowledgements, and times out if any acknowledgement
  is missing. The patch is kept under `patches/` and applies only to the pinned
  source shape; installation stops if that source no longer matches.
- After applying the patch and asking the sidecar to republish, its API returned
  success. `scripts/verify-locator.sh` queried `wss://relay.primal.net` and
  verified a fresh, signed Kind 30058 event, `d=web-locator`, with one endpoint:
  `http://1.43.63.94:8080`.
- Caddy and sidecar were separately killed with `SIGKILL`; systemd restarted
  each, and the local smoke test passed after recovery.
- The sidecar ran under the systemd sandbox with interface discovery and its
  database/certificate paths available. It logged a repeated admin backup
  warning about an invalid public-key argument; that warning did not prevent
  service setup or locator publication and should be investigated upstream.

### Current VM resolver check

- The current Debian VM serves the test page at `http://192.168.122.162:8080/`.
  A host-only fixture publisher signed and published a fresh `web-locator`
  event for the reusable test identity; its private key was not copied into the
  VM. The public relay event advertised the VM's private libvirt address and
  used a one-hour TTL.
- NCC Browser opened `ncc://<test-npub>/web/`, resolved the fresh event, fetched
  the page from the VM, and rendered it with `HTTP 200 OK`. The page's own
  locator lookup also verified the signed relay event. The test app now routes
  the browser's `/_/<service>/` internal path to its home page.
- This verifies the browser contract against a sidecar-shaped event and the
  VM page from the host. It does not verify the current VM sidecar publishing
  with that identity, or external reachability of the advertised address.
- The host NAT check reports route source `192.168.86.67` and public egress
  `1.43.63.94`. The VM is behind libvirt NAT, and no inbound forwarding was
  configured. Neither address is evidence that the VM's port 8080 is reachable
  from the public internet.
- The current VM sidecar later published its own `web-locator` for
  `npub1zj38vga6c3ynujrc5pypfv3z3ldjukx60sd62ssk58vm8smtvlsqk7q5gy`. NCC
  Browser resolved that event and rendered the page through the VM's private
  HTTPS endpoint. The page's relay lookup verified the same event. Its service
  was then set inactive so the VM does not continuously republish a private
  libvirt address; the already-published record expires after one hour.

## Remaining acceptance checks

- `scripts/check-nat.sh` was exercised with a matching WAN argument (`1.43.63.94`,
  exit 0), a different public address (`8.8.8.8`, upstream NAT, exit 2), and a
  CGNAT-range address (`100.64.12.4`, likely CGNAT, exit 2). The live no-argument
  check reported public egress `1.43.63.94` and host route source
  `192.168.86.67`, confirming NAT on this host. The router's actual WAN address
  was unavailable, so this does not establish whether inbound forwarding works.
- The VM was behind libvirt NAT with no inbound router forwarding. External
  reachability of `http://1.43.63.94:8080` was therefore not tested; configure
  real router forwarding and firewall rules before relying on this locator.
- `ncc-browser` resolution passed against both the host-published VM fixture
  and a locator emitted by the current VM sidecar.
- Port-change republish passed with a profile update: Caddy and the sidecar web
  profile were changed from port 8443 to 8444. Without a manual republish call,
  the sidecar published a new locator on its manager cycle. `scripts/verify-locator.sh`
  confirmed the fresh event on Primal with endpoint
  `https://192.168.122.162:8444/`. The test requires updating the sidecar profile
  along with Caddy; it does not show that the sidecar discovers a Caddy port
  change on its own.
- Automatic republish after a public-IP change has not passed; see the M3 probe
  result below.
- The one-week unattended soak and 72-hour IP-change/crash test remain future
  operational checks.

## M3 TLS contract

- In the pinned sidecar source, `runPublishCycle` calls `ensureSelfSignedCert`
  under `./certs/<service-record-id>`, derives `k` from the certificate SPKI,
  and `buildInventory` attaches it to secure (`https`/`wss`) endpoints. The
  Kind 30058 payload carries that endpoint `k` in JSON. NCC Browser pins the
  certificate's SPKI and accepts self-signed certificates only on an exact
  match.
- `make enable-tls SERVICE_RECORD_ID=<id>` configures Caddy to use that same
  sidecar certificate on port 8443. The sidecar systemd drop-in adds the `caddy`
  supplementary group and a restrictive umask so regenerated private keys
  remain readable by Caddy but not other local users.
- The sidecar stores service nsecs in its SQLite database; it does not consume
  `NCC_NSEC` or systemd credentials. The installer restricts the database
  directory/file permissions, but moving the key out of SQLite into
  `systemd-creds` requires a sidecar storage integration and remains open.
- M3 VM test: the sidecar generated the record-2 certificate, Caddy served that
  same certificate on port 8443, and a host check saw HTTP 200 with the expected
  SPKI hash. The sidecar published a signed HTTPS locator containing that `k`;
  NCC Browser resolved it and rendered the app. A separate deliberately wrong
  pin was refused with `k-mismatch`. `make disable-tls` and `make enable-tls`
  both validated, and SIGKILL recovery for Caddy and the sidecar plus the VM
  smoke check passed.
- Certificate rotation was exercised: the sidecar regenerated its certificate,
  `make enable-tls SERVICE_RECORD_ID=2` reloaded Caddy with the new files, the
  sidecar republished the changed `k`, and a fresh NCC Browser session rendered
  the HTTPS service using the rotated pin.
- External TLS reachability still depends on operator firewall and router
  forwarding for port 8443. The 72-hour soak remains unrun, and the simulated
  IP-change criterion has not passed. The DB-backed sidecar key storage also
  lacks the planned `systemd-creds` integration, so M3's long-duration and
  at-rest key criteria are not fully closed.
- Follow-up VM probe: temporarily changed the guest interface address and
  forced the active record to publish. The sidecar reported success but retained
  the previously configured `192.168.122.162` endpoint, so this did not pass the
  IP-change criterion. The guest's original DHCP address and route were
  restored, Caddy HTTPS returned 200, and the web record was returned to
  inactive. Repeat this check with a controlled DHCP/NAT address change and
  verify the resulting relay event before claiming automatic IP-change support.

The port-change test was cleaned up after verification: Caddy and the sidecar
profile were restored to port 8443, a fresh 8443 locator was republished and
verified on Primal, and the sidecar web record was returned to inactive. Caddy
HTTPS returned HTTP 200 after restoration.

M0 remains open until the advertised endpoint is reachable from outside the
host's NAT. The sidecar publisher acknowledgement patch is an integration fix
to the existing sidecar, not a separate NCC publisher.


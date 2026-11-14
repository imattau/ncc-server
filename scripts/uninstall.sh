#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo 'Run with sudo or as root.' >&2; exit 1; }

systemctl disable --now ncc-sidecar.service
rm -f /etc/systemd/system/ncc-sidecar.service.d/ncc-server.conf
rmdir /etc/systemd/system/ncc-sidecar.service.d 2>/dev/null || true
rm -f /etc/systemd/system/caddy.service.d/ncc-server.conf
rmdir /etc/systemd/system/caddy.service.d 2>/dev/null || true
rm -f /etc/ncc-server/Caddyfile
systemctl daemon-reload
systemctl reset-failed
systemctl restart caddy.service

cat <<'EOF'
NCC-Server service configuration has been removed. The sidecar installer owns
its unit, code, and database; use its documented remove command if you also want
to delete them. /etc/ncc-server/ncc-server.env and /srv/ncc-server/public were
kept so configuration and site content are not lost.
EOF


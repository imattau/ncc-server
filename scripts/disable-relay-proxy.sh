#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR=/etc/ncc-server
ENV_FILE="$CONFIG_DIR/ncc-server.env"
CADDYFILE="$CONFIG_DIR/Caddyfile"
RELAY_SNIPPET="$CONFIG_DIR/relay-proxy.caddy"

[[ "$(id -u)" -eq 0 ]] || { echo 'Error: run with sudo or as root' >&2; exit 1; }
[[ -f "$ENV_FILE" && -f "$CADDYFILE" && -f "$RELAY_SNIPPET" ]] || { echo 'Error: NCC-Server is not installed' >&2; exit 1; }

backup="$(mktemp /tmp/ncc-relay-proxy.XXXXXX)"
cp -a "$RELAY_SNIPPET" "$backup"
restore() {
  cp -a "$backup" "$RELAY_SNIPPET"
  systemctl restart caddy.service || true
  rm -f "$backup"
}
trap restore ERR

: > "$RELAY_SNIPPET"
chown root:root "$RELAY_SNIPPET"
chmod 0644 "$RELAY_SNIPPET"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
caddy validate --adapter caddyfile --config "$CADDYFILE"
systemctl restart caddy.service
rm -f "$backup"
trap - ERR
echo 'Ditto Relay WSS reverse proxy disabled.'

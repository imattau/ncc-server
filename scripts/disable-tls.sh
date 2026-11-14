#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR=/etc/ncc-server
ENV_FILE="$CONFIG_DIR/ncc-server.env"
CADDYFILE="$CONFIG_DIR/Caddyfile"

[[ "$(id -u)" -eq 0 ]] || { echo 'Error: run with sudo or as root' >&2; exit 1; }
[[ -f "$ENV_FILE" && -f "$CADDYFILE" ]] || { echo 'Error: NCC-Server is not installed' >&2; exit 1; }

backup_dir="$(mktemp -d /tmp/ncc-server-tls.XXXXXX)"
cp -a "$ENV_FILE" "$backup_dir/ncc-server.env"
cp -a "$CADDYFILE" "$backup_dir/Caddyfile"
restore() {
  cp -a "$backup_dir/ncc-server.env" "$ENV_FILE"
  cp -a "$backup_dir/Caddyfile" "$CADDYFILE"
  systemctl restart caddy.service || true
  rm -rf "$backup_dir"
}

sed -i '/^CONTENT_TLS_PORT=/d; /^TLS_CERT_PATH=/d; /^TLS_KEY_PATH=/d' "$ENV_FILE"
cp "$PROJECT_DIR/caddy/Caddyfile" "$CADDYFILE"
chown root:root "$ENV_FILE" "$CADDYFILE"
chmod 0600 "$ENV_FILE"
chmod 0644 "$CADDYFILE"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
if ! caddy validate --adapter caddyfile --config "$CADDYFILE"; then
  restore
  echo 'Error: Caddy rejected the HTTP configuration; previous config restored' >&2
  exit 1
fi
if ! systemctl restart caddy.service; then
  restore
  echo 'Error: Caddy failed to restart; previous config restored' >&2
  exit 1
fi
rm -rf "$backup_dir"
echo 'TLS listener disabled; Caddy is serving HTTP only.'
echo 'Set the sidecar service protocol back to http and republish before relying on its locator.'

#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_RECORD_ID="${1:-}"
CONFIG_DIR=/etc/ncc-server
ENV_FILE="$CONFIG_DIR/ncc-server.env"
CADDYFILE="$CONFIG_DIR/Caddyfile"
RELAY_SNIPPET="$CONFIG_DIR/relay-proxy.caddy"
CERT_DIR="/opt/ncc-sidecar/certs/$SERVICE_RECORD_ID"

die() { echo "Error: $*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || die 'run with sudo or as root'
[[ "$SERVICE_RECORD_ID" =~ ^[1-9][0-9]*$ ]] || die 'pass the numeric sidecar service record ID'
[[ -f "$ENV_FILE" && -f "$CADDYFILE" && -f "$RELAY_SNIPPET" ]] || die 'NCC-Server is not installed'
[[ -s "$CERT_DIR/server.crt" && -s "$CERT_DIR/server.key" ]] || die "sidecar certificate not found under $CERT_DIR; publish the relay service once first"
command -v caddy >/dev/null || die 'Caddy is not installed'
id ncc-sidecar >/dev/null 2>&1 || die 'ncc-sidecar service account is missing'
getent group caddy >/dev/null || die 'caddy group is missing'
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:13131/ >/dev/null \
  || die 'Ditto Relay is not responding on 127.0.0.1:13131'

chown ncc-sidecar:caddy "$CERT_DIR"
chmod 2750 "$CERT_DIR"
chown ncc-sidecar:caddy "$CERT_DIR/server.crt" "$CERT_DIR/server.key"
chmod 0640 "$CERT_DIR/server.crt" "$CERT_DIR/server.key"

backup="$(mktemp /tmp/ncc-relay-proxy.XXXXXX)"
cp -a "$RELAY_SNIPPET" "$backup"
restore() {
  cp -a "$backup" "$RELAY_SNIPPET"
  systemctl restart caddy.service || true
  rm -f "$backup"
}
trap restore ERR

cat > "$RELAY_SNIPPET" <<EOF
:8444 {
	tls $CERT_DIR/server.crt $CERT_DIR/server.key
	header {
		Referrer-Policy "strict-origin-when-cross-origin"
		X-Content-Type-Options "nosniff"
	}
	request_body {
		max_size 5MB
	}
	reverse_proxy 127.0.0.1:13131 {
		header_up X-Real-IP {remote_host}
	}
	log {
		output stdout
	}
}
EOF
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
echo "Ditto Relay WSS reverse proxy is active on TCP 8444 using service record $SERVICE_RECORD_ID."

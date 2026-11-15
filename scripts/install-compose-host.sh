#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "Error: $*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || die 'run this script as root on the Debian 12/Ubuntu host'
command -v apt-get >/dev/null || die 'automated host installation supports Debian/Ubuntu only'

if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  install -m 0600 "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  echo 'Created .env from .env.example.'
fi

set -a
# shellcheck disable=SC1090
source "$PROJECT_DIR/.env"
set +a
DITTO_RELAY_REV="${DITTO_RELAY_REV:-e8974053dcf99ac952d1951deaffec105aeb08f1}"

write_env_value() {
  local name="$1" value="$2"
  python3 - "$PROJECT_DIR/.env" "$name" "$value" <<'PY'
import os, pathlib, sys, tempfile
path, name, value = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
lines = path.read_text().splitlines()
out, replaced = [], False
for line in lines:
    if line.startswith(name + '='):
        if not replaced:
            out.append(name + '=' + value)
            replaced = True
    else:
        out.append(line)
if not replaced:
    out.append(name + '=' + value)
fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.env.')
with os.fdopen(fd, 'w') as handle:
    handle.write('\n'.join(out) + '\n')
os.chmod(tmp, 0o600)
os.replace(tmp, path)
PY
}

ask_value() {
  local name="$1" label="$2" value="${!1:-}"
  if [[ -z "$value" ]]; then
    read -r -p "$label: " value
    [[ -n "$value" ]] || die "$name is required"
    write_env_value "$name" "$value"
  fi
  printf -v "$name" '%s' "$value"
  export "$name"
}

ensure_env_default() {
  local name="$1" default="$2" value="${!1:-}"
  if [[ -z "$value" ]]; then
    value="$default"
    write_env_value "$name" "$value"
  fi
  printf -v "$name" '%s' "$value"
  export "$name"
}

if [[ -z "${PUBLIC_IPV4:-}" && -n "${PUBLIC_ENDPOINT_HOST:-}" ]]; then
  PUBLIC_IPV4="$PUBLIC_ENDPOINT_HOST"
  write_env_value PUBLIC_IPV4 "$PUBLIC_IPV4"
  export PUBLIC_IPV4
fi
ask_value PUBLIC_IPV4 'Server public IPv4 address (no DNS name, scheme, or port)'
ensure_env_default CONTENT_PORT 8080
ensure_env_default CONTENT_TLS_PORT 8443
ensure_env_default SEARCH_TLS_PORT 8447
ensure_env_default NCC_OPERATOR_PUBKEY ''
python3 - "$PUBLIC_IPV4" <<'PY'
import ipaddress, sys
try:
    if ipaddress.ip_address(sys.argv[1]).version != 4:
        raise ValueError('IPv4 required')
except ValueError as error:
    raise SystemExit(f'PUBLIC_IPV4 must be a public IPv4 address: {error}')
PY

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl git openssl python3 rsync docker.io docker-compose
systemctl enable --now docker.service

install -d -m 0755 /etc/ncc-server
install -d -m 0755 "$CONTENT_ROOT"
install -d -o "$SIDECAR_UID" -g "$SIDECAR_GID" -m 0700 "$SIDECAR_DATA_DIR"
install -d -o "$SIDECAR_UID" -g "$SIDECAR_CERT_GID" -m 0750 "$SIDECAR_CERT_DIR"
install -d -o "$NPANEL_UID" -g "$NPANEL_GID" -m 0750 "$NPANEL_DATA_DIR"
install -d -o "$SEARCH_UID" -g "$SEARCH_GID" -m 0750 "$SEARCH_DATA_DIR"
install -d -o "$TOR_UID" -g "$TOR_GID" -m 0750 "$TOR_DATA_DIR"
install -d -o root -g root -m 0755 "$(dirname "$TOR_CONFIG_FILE")"
if [[ ! -e "$TOR_CONFIG_FILE" ]]; then install -o root -g root -m 0644 /dev/null "$TOR_CONFIG_FILE"; fi
install -d -o root -g root -m 0755 "$(dirname "$DITTO_ENV_FILE")"
if [[ ! -e "$DITTO_ENV_FILE" ]]; then
  umask 077
  cat > "$DITTO_ENV_FILE" <<EOF
# First-run placeholder. Replaced by the operator identity setup before relay start.
RELAY_URL=wss://$PUBLIC_IPV4:${CONTENT_TLS_PORT}/relay/
NOSTR_SECRET_KEY=setup-pending
RELAY_PORT=127.0.0.1:13131
IP_HEADER=X-Real-IP
EOF
  chown root:root "$DITTO_ENV_FILE"
  chmod 0600 "$DITTO_ENV_FILE"
fi

if [[ ! -d "$DITTO_SOURCE_DIR/.git" ]]; then
  install -d -o root -g root -m 0755 "$(dirname "$DITTO_SOURCE_DIR")"
  git clone --filter=blob:none --no-checkout https://gitlab.com/soapbox-pub/ditto-relay.git "$DITTO_SOURCE_DIR"
fi
git -C "$DITTO_SOURCE_DIR" fetch --depth 1 origin "$DITTO_RELAY_REV"
git -C "$DITTO_SOURCE_DIR" checkout --force --detach FETCH_HEAD
[[ -f "$DITTO_SOURCE_DIR/Dockerfile" ]] || die "Ditto Relay source is incomplete: $DITTO_SOURCE_DIR"
sed -i '/^name: ditto-relay$/d' "$DITTO_SOURCE_DIR/docker-compose.yml"
sysctl -w vm.max_map_count=262144 >/dev/null
install -d -o root -g root -m 0755 /etc/sysctl.d
echo 'vm.max_map_count=262144' > /etc/sysctl.d/99-ncc-server-opensearch.conf

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose -p ncc-bundle -f "$PROJECT_DIR/compose.yaml")
else
  COMPOSE=(docker-compose -p ncc-bundle -f "$PROJECT_DIR/compose.yaml")
fi
docker volume inspect "$OPENSEARCH_VOLUME" >/dev/null 2>&1 || docker volume create "$OPENSEARCH_VOLUME" >/dev/null
"${COMPOSE[@]}" config >/dev/null
"${COMPOSE[@]}" build
# Start the identity-independent services. The bootstrap then generates or
# reuses the root-only host identity, initializes the sidecar, provisions the
# service records, and starts the full stack.
"${COMPOSE[@]}" up -d tor sidecar opensearch npanel ditto-web search search-ui
bash "$PROJECT_DIR/scripts/bootstrap-compose-host.sh"

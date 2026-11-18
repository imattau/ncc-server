#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "Error: $*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || die 'run this script as root on the Debian 12/Ubuntu host'
command -v apt-get >/dev/null || die 'automated host installation supports Debian/Ubuntu only'

preflight_checks() {
  local problems=0 mem_kib mem_gib avail_kib avail_gib port

  mem_kib="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  mem_gib=$(( mem_kib / 1024 / 1024 ))
  if (( mem_kib < 4 * 1024 * 1024 )); then
    echo "Pre-flight: ${mem_gib} GiB RAM detected; the bundle wants at least 4 GiB (OpenSearch alone uses a 1 GiB heap). Containers may crash or get OOM-killed." >&2
    problems=1
  fi

  avail_kib="$(df --output=avail -k "$PROJECT_DIR" | tail -n1 | tr -d ' ')"
  avail_gib=$(( avail_kib / 1024 / 1024 ))
  if (( avail_kib < 10 * 1024 * 1024 )); then
    echo "Pre-flight: only ${avail_gib} GiB free on $(df --output=target "$PROJECT_DIR" | tail -n1 | tr -d ' '); image pulls and OpenSearch data can need more than that." >&2
    problems=1
  fi

  if command -v ss >/dev/null 2>&1; then
    for port in "${CONTENT_PORT:-8080}" "${CONTENT_TLS_PORT:-8443}" \
      "${RELAY_TLS_PORT:-8444}" "${NPANEL_TLS_PORT:-8445}" \
      "${DITTO_WEB_TLS_PORT:-8446}" "${SEARCH_TLS_PORT:-8447}" \
      "${ADMIN_PANEL_TLS_PORT:-8448}" "${ADMIN_PANEL_PORT:-8081}" \
      "${TOR_NPANEL_PORT:-18045}" "${TOR_DITTO_WEB_PORT:-18046}" \
      "${TOR_SEARCH_PORT:-18047}" "${TOR_ADMIN_PORT:-18048}"; do
      ss -Htln "( sport = :$port )" 2>/dev/null | grep -q . || continue
      if command -v docker >/dev/null 2>&1 \
        && docker ps --filter 'label=com.docker.compose.project=ncc-bundle' --format '{{.Ports}}' 2>/dev/null \
           | grep -q ":${port}->"; then
        continue
      fi
      echo "Pre-flight: port $port is already in use by something other than this bundle; Compose will fail to bind it." >&2
      problems=1
    done
  fi

  if (( problems )) && [[ -z "${NCC_SKIP_PREFLIGHT:-}" ]]; then
    if [[ -t 0 ]]; then
      local reply
      read -r -p 'Continue despite the pre-flight warnings above? [y/N] ' reply
      [[ "${reply,,}" == y || "${reply,,}" == yes ]] \
        || die 'aborted after pre-flight warnings; set NCC_SKIP_PREFLIGHT=1 to bypass this prompt'
    else
      echo 'Pre-flight: continuing despite the warnings above (non-interactive); set NCC_SKIP_PREFLIGHT=1 to silence this check.' >&2
    fi
  fi
}

if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  install -m 0600 "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  echo 'Created .env from .env.example.'
fi

set -a
# shellcheck disable=SC1090
source "$PROJECT_DIR/.env"
set +a

[[ "${TOR_UID:-102}" == 102 && "${TOR_GID:-109}" == 109 ]] \
  || die 'the published Tor image uses UID 102 and GID 109; restore those values in .env before installing'

preflight_checks

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

ask_public_ipv4() {
  local value="${PUBLIC_IPV4:-}" detected
  if [[ -z "$value" ]]; then
    detected="$(curl -4 --fail --silent --show-error --max-time 10 https://api.ipify.org 2>/dev/null || true)"
    if [[ -n "$detected" && -t 0 ]]; then
      read -r -p "Server public IPv4 address [detected: $detected]: " value
      value="${value:-$detected}"
    elif [[ -n "$detected" ]]; then
      echo "Pre-flight: no terminal attached; using the detected public IPv4 $detected. Set PUBLIC_IPV4 to override." >&2
      value="$detected"
    else
      read -r -p 'Server public IPv4 address (no DNS name, scheme, or port; auto-detect failed): ' value
    fi
    [[ -n "$value" ]] || die 'PUBLIC_IPV4 is required'
    write_env_value PUBLIC_IPV4 "$value"
  fi
  printf -v PUBLIC_IPV4 '%s' "$value"
  export PUBLIC_IPV4
}
ask_public_ipv4
ensure_env_default CONTENT_PORT 8080
ensure_env_default CONTENT_TLS_PORT 8443
ensure_env_default RELAY_TLS_PORT 8444
ensure_env_default NPANEL_TLS_PORT 8445
ensure_env_default DITTO_WEB_TLS_PORT 8446
ensure_env_default SEARCH_TLS_PORT 8447
ensure_env_default ADMIN_PANEL_TLS_PORT 8448
ensure_env_default ADMIN_PANEL_PORT 8081
ensure_env_default NODE_AGENT_PORT 3010
if [[ -z "${NODE_AGENT_TOKEN:-}" ]]; then
  NODE_AGENT_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  write_env_value NODE_AGENT_TOKEN "$NODE_AGENT_TOKEN"
  export NODE_AGENT_TOKEN
fi
ensure_env_default TOR_NPANEL_PORT 18045
ensure_env_default TOR_DITTO_WEB_PORT 18046
ensure_env_default TOR_SEARCH_PORT 18047
ensure_env_default TOR_ADMIN_PORT 18048
ensure_env_default NCC_OPERATOR_PUBKEY ''
python3 - "$PUBLIC_IPV4" <<'PY'
import ipaddress, sys
try:
    if ipaddress.ip_address(sys.argv[1]).version != 4:
        raise ValueError('IPv4 required')
except ValueError as error:
    raise SystemExit(f'PUBLIC_IPV4 must be a public IPv4 address: {error}')
PY

if [[ -z "${NCC_SKIP_NAT_CHECK:-}" && -x "$PROJECT_DIR/scripts/check-nat.sh" ]] && command -v ip >/dev/null 2>&1; then
  set +e
  nat_output="$("$PROJECT_DIR/scripts/check-nat.sh" 2>&1)"
  nat_status=$?
  set -e
  echo "$nat_output"
  if (( nat_status != 0 )); then
    echo "Pre-flight: could not confirm $PUBLIC_IPV4 is directly reachable from the internet (see above). This is advisory only and the install continues. If clients can't reach the server afterwards, run 'scripts/check-nat.sh <router-wan-ipv4>' from a workstation on the same router to check for CGNAT/upstream NAT." >&2
  fi
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl git openssl python3 rsync docker.io docker-compose
systemctl enable --now docker.service

install -d -m 0755 /etc/ncc-server
install -d -m 0755 "$CONTENT_ROOT"
CONTENT_EMPTY=false
[[ -z "$(find "$CONTENT_ROOT" -mindepth 1 -maxdepth 1 ! -name ncc-config.json -print -quit 2>/dev/null)" ]] \
  && CONTENT_EMPTY=true
CONTENT_IS_PLACEHOLDER=false
CONTENT_IS_MANAGED_WELCOME=false
CONTENT_IS_LEGACY_NCC_TEST=false
if [[ -f "$CONTENT_ROOT/index.html" ]]; then
  grep -q 'This is a placeholder page served from CONTENT_ROOT' "$CONTENT_ROOT/index.html" \
    && CONTENT_IS_PLACEHOLDER=true
  grep -q 'name="ncc-page" content="welcome"' "$CONTENT_ROOT/index.html" \
    && CONTENT_IS_MANAGED_WELCOME=true
  grep -q 'property="og:title" content="NCC Server Test"' "$CONTENT_ROOT/index.html" \
    && CONTENT_IS_LEGACY_NCC_TEST=true
fi

if [[ "$CONTENT_EMPTY" == true || "$CONTENT_IS_PLACEHOLDER" == true || \
  "$CONTENT_IS_MANAGED_WELCOME" == true || "$CONTENT_IS_LEGACY_NCC_TEST" == true ]]; then
  if [[ -f "$PROJECT_DIR/public/index.html" ]] \
    && grep -q 'name="ncc-page" content="welcome"' "$PROJECT_DIR/public/index.html"; then
    rsync -a --delete --chown="root:$CADDY_GID" "$PROJECT_DIR/public/" "$CONTENT_ROOT/"
    chown -R "root:$CADDY_GID" "$CONTENT_ROOT"
    find "$CONTENT_ROOT" -type d -exec chmod 0755 {} +
    find "$CONTENT_ROOT" -type f -exec chmod 0644 {} +
    echo "Installed the bundled MKStack welcome page in $CONTENT_ROOT."
  elif [[ "$CONTENT_EMPTY" == true ]]; then
    cat > "$CONTENT_ROOT/index.html" <<'HTML'
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>NCC-Server</title></head>
<body>
<h1>NCC-Server is running</h1>
<p>This is a placeholder page served from CONTENT_ROOT. Replace it with your
own site, or deploy the included MKStack welcome page (see
docs/deployment-compose.md).</p>
</body>
</html>
HTML
    chown root:root "$CONTENT_ROOT/index.html"
    chmod 0644 "$CONTENT_ROOT/index.html"
    echo "Wrote a placeholder page to $CONTENT_ROOT/index.html so the web root serves HTTP 200 before you deploy real content."
  fi
fi
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
RELAY_URL=wss://$PUBLIC_IPV4:${RELAY_TLS_PORT}/relay/
NOSTR_SECRET_KEY=setup-pending
RELAY_PORT=127.0.0.1:13131
IP_HEADER=X-Real-IP
EOF
  chown root:root "$DITTO_ENV_FILE"
  chmod 0600 "$DITTO_ENV_FILE"
fi

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
"${COMPOSE[@]}" pull
# Keep public service locators in sync with a changing ISP address. The unit
# points at this checkout, so timer runs use the same Compose project/config.
chmod 0755 "$PROJECT_DIR/scripts/reconcile-public-ip.py"
cat > /etc/systemd/system/ncc-public-ip-reconcile.service <<EOF
[Unit]
Description=Reconcile NCC public IP service locators
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$PROJECT_DIR
ExecStart=$PROJECT_DIR/scripts/reconcile-public-ip.py
TimeoutStartSec=10min
EOF
cat > /etc/systemd/system/ncc-public-ip-reconcile.timer <<'EOF'
[Unit]
Description=Check NCC public IP address periodically

[Timer]
OnBootSec=3min
OnUnitActiveSec=15min
RandomizedDelaySec=2min
Persistent=true
Unit=ncc-public-ip-reconcile.service

[Install]
WantedBy=timers.target
EOF
chmod 0644 /etc/systemd/system/ncc-public-ip-reconcile.service /etc/systemd/system/ncc-public-ip-reconcile.timer
systemctl daemon-reload
systemctl enable --now ncc-public-ip-reconcile.timer
# Start the identity-independent services. The bootstrap then generates or
# reuses the root-only host identity, initializes the sidecar, provisions the
# service records, and starts the full stack.
"${COMPOSE[@]}" up -d tor sidecar opensearch npanel ditto-web search-crawler search search-ui
bash "$PROJECT_DIR/scripts/bootstrap-compose-host.sh"

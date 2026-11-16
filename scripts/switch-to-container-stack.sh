#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
LEGACY_DITTO_DIR="${LEGACY_DITTO_DIR:-/opt/ditto-relay/source}"
LEGACY_UNITS=(caddy.service ncc-sidecar.service npanel.service tor@default.service)
COMPOSE=(docker-compose -p ncc-bundle -f "$PROJECT_DIR/compose.yaml")
LEGACY_COMPOSE=(docker-compose -p ditto-relay -f "$LEGACY_DITTO_DIR/docker-compose.yml")
switched=false

die() { echo "Error: $*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || die 'run as root on the Debian VM'
[[ -f "$PROJECT_DIR/.env" ]] || die 'copy .env.example to .env and set VM paths first'
set -a
# shellcheck disable=SC1090
source "$PROJECT_DIR/.env"
set +a
OPERATOR_IDENTITY_FILE="${NCC_IDENTITY_FILE:-/etc/ncc-server/operator-identity.json}"
[[ -f "$OPERATOR_IDENTITY_FILE" ]] || die "operator identity is missing: $OPERATOR_IDENTITY_FILE"
NCC_OPERATOR_PUBKEY="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pubkey"])' "$OPERATOR_IDENTITY_FILE")"
export NCC_OPERATOR_PUBKEY

rollback() {
  local rc=$?
  if [[ "$switched" == true ]]; then
    echo 'Container switch failed; restoring the existing systemd and Ditto services.' >&2
    "${COMPOSE[@]}" ps >&2 || true
    for service in sidecar tor npanel opensearch relay ditto-web caddy; do
      "${COMPOSE[@]}" logs --no-color --tail=80 "$service" >&2 || true
      docker inspect --format '{{.Name}} {{json .State}}' "ncc-bundle_${service}_1" >&2 2>/dev/null || true
    done
    "${COMPOSE[@]}" down || true
    systemctl enable "${LEGACY_UNITS[@]}" >/dev/null 2>&1 || true
    systemctl start tor@default.service npanel.service ncc-sidecar.service caddy.service || true
    if [[ -f "$LEGACY_DITTO_DIR/docker-compose.yml" ]]; then
      "${LEGACY_COMPOSE[@]}" up -d || true
    fi
  fi
  exit "$rc"
}
trap rollback ERR INT TERM

"${COMPOSE[@]}" config >/dev/null
docker volume inspect "$(awk -F= '/^OPENSEARCH_VOLUME=/{print $2}' "$PROJECT_DIR/.env")" >/dev/null
"${COMPOSE[@]}" pull

SIDECAR_NODE="${SIDECAR_NODE:-/opt/ncc-sidecar/.node/bin/node}"
[[ -x "$SIDECAR_NODE" ]] || die 'the existing sidecar Node runtime is missing'
"$SIDECAR_NODE" "$PROJECT_DIR/scripts/configure-npanel-host.mjs"
"$SIDECAR_NODE" "$PROJECT_DIR/scripts/configure-ditto-web.mjs"

switched=true
systemctl stop caddy.service ncc-sidecar.service npanel.service tor@default.service
"${LEGACY_COMPOSE[@]}" down
"${COMPOSE[@]}" up -d

deadline=$((SECONDS + 240))
while (( SECONDS < deadline )); do
  healthy=true
  for service in sidecar opensearch relay npanel ditto-web caddy; do
    container="ncc-bundle_${service}_1"
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    [[ "$state" == healthy ]] || healthy=false
  done
  if [[ "$healthy" == true ]] \
    && curl -fsS --max-time 5 http://127.0.0.1:3000/ >/dev/null \
    && curl -fsS --max-time 5 "http://127.0.0.1:${CONTENT_PORT:-8080}/" >/dev/null \
    && curl -fsSk --max-time 5 "https://127.0.0.1:${NPANEL_TLS_PORT:-8445}/api/instance" | grep -Fq "${PUBLIC_IPV4}" \
    && curl -fsSk --max-time 5 "https://127.0.0.1:${DITTO_WEB_TLS_PORT:-8446}/" | grep -qi 'ditto' \
    && curl -fsSk --max-time 5 "https://127.0.0.1:${CONTENT_TLS_PORT:-8443}/nsite/${SITE_NPUB:-npub1asy6ca3ppxa70e6z7lpm2d4tuh09sh3x5cg4485f0juwgvxm77kq6pl8fr}/" | grep -q 'NCC nsite served' \
    && curl -fsSk --max-time 5 -H 'Accept: application/nostr+json' "https://127.0.0.1:${RELAY_TLS_PORT:-8444}/relay/" | grep -q '"name"' \
    && ss -lnt | grep -q '127.0.0.1:9051'; then
    break
  fi
  sleep 3
done
(( SECONDS < deadline )) || die 'container health or route smoke checks timed out'

systemctl disable "${LEGACY_UNITS[@]}" >/dev/null
switched=false
trap - ERR INT TERM
echo 'Container stack is healthy. Legacy systemd units are disabled; their data remains in place.'
"${COMPOSE[@]}" ps

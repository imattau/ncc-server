#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$PROJECT_DIR/.env"
  set +a
fi

BASE_HTTP="${BASE_HTTP:-http://127.0.0.1:8080}"
PUBLIC_IPV4="${PUBLIC_IPV4:-127.0.0.1}"
BASE_HTTPS="${BASE_HTTPS:-https://localhost:8443}"
RELAY_HTTPS="${RELAY_HTTPS:-https://localhost:${RELAY_TLS_PORT:-8444}/relay/}"
NPANEL_HTTPS="${NPANEL_HTTPS:-https://localhost:${NPANEL_TLS_PORT:-8445}}"
DITTO_HTTPS="${DITTO_HTTPS:-https://localhost:${DITTO_WEB_TLS_PORT:-8446}}"
# Same origin/port for both -- see container/Caddyfile's comment on the
# search block for why the API can't be a separate host/port.
SEARCH_UI_HTTPS="${SEARCH_UI_HTTPS:-https://localhost:${SEARCH_TLS_PORT:-8447}}"
SEARCH_API_HTTPS="${SEARCH_API_HTTPS:-$SEARCH_UI_HTTPS}"
SITE_NPUB="${SITE_NPUB:-}"

check() {
  local label="$1" url="$2"; shift 2
  local code host port
  local -a curl_args=(--silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10)
  if [[ "$url" =~ ^https://([^/:]+):([0-9]+) ]]; then
    host="${BASH_REMATCH[1]}"
    port="${BASH_REMATCH[2]}"
    [[ "$host" != localhost ]] || curl_args+=(--resolve "${host}:${port}:127.0.0.1")
  fi
  code="$(curl "${curl_args[@]}" "$@" "$url")"
  [[ "$code" == 200 ]] || { echo "$label: HTTP $code" >&2; return 1; }
  echo "$label: HTTP $code"
}

check 'IP HTTP test app route' "$BASE_HTTP/"
check 'Npanel HTTPS dashboard route' "$NPANEL_HTTPS/api/instance" --insecure
dashboard_port="${NPANEL_TLS_PORT:-8445}"
dashboard_json="$(curl --fail --silent --show-error --insecure --max-time 10 \
  --resolve "localhost:${dashboard_port}:127.0.0.1" "$NPANEL_HTTPS/api/instance")"
[[ "$dashboard_json" == *"$PUBLIC_IPV4"* ]] || { echo 'Npanel dashboard host did not match.' >&2; exit 1; }
if [[ -n "$SITE_NPUB" ]]; then
  check 'Nsite HTTPS route' "$BASE_HTTPS/nsite/$SITE_NPUB/" --insecure
  check 'Nsite root-relative JavaScript' "$BASE_HTTPS/nsite/$SITE_NPUB/app.js" --insecure
fi
check 'Ditto HTTPS web route' "$DITTO_HTTPS/" --insecure
check 'ncc-search HTTPS UI route' "$SEARCH_UI_HTTPS/" --insecure -H "Host: $PUBLIC_IPV4"
check 'ncc-search HTTPS API route' "$SEARCH_API_HTTPS/search?q=a" --insecure -H "Host: $PUBLIC_IPV4"
check 'Ditto WSS NIP-11 route' "$RELAY_HTTPS" --insecure -H 'Accept: application/nostr+json'
docker-compose -p ncc-bundle -f compose.yaml ps

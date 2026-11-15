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
BASE_HTTPS="${BASE_HTTPS:-https://127.0.0.1:8443}"
RELAY_HTTPS="${RELAY_HTTPS:-https://127.0.0.1:8444}"
SITE_NPUB="${SITE_NPUB:-}"
DASHBOARD_HOST="${DASHBOARD_HOST:-1.43.63.94.nip.io}"
DITTO_WEB_HOST="${DITTO_WEB_HOST:-ditto.1.43.63.94.nip.io}"

check() {
  local label="$1" url="$2"; shift 2
  local code
  code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 "$@" "$url")"
  [[ "$code" == 200 ]] || { echo "$label: HTTP $code" >&2; return 1; }
  echo "$label: HTTP $code"
}

check 'IP HTTP test app route' "$BASE_HTTP/"
check 'Npanel HTTP dashboard route' "$BASE_HTTP/api/instance" -H "Host: $DASHBOARD_HOST"
check 'Ditto HTTP web route' "$BASE_HTTP/" -H "Host: $DITTO_WEB_HOST"
dashboard_json="$(curl --fail --silent --show-error --max-time 10 -H "Host: $DASHBOARD_HOST" "$BASE_HTTP/api/instance")"
[[ "$dashboard_json" == *"$DASHBOARD_HOST"* ]] || { echo 'Npanel dashboard host did not match.' >&2; exit 1; }
if [[ -n "$SITE_NPUB" ]]; then
  check 'Nsite HTTPS route' "$BASE_HTTPS/nsite/$SITE_NPUB/" --insecure
  check 'Nsite root-relative JavaScript' "$BASE_HTTPS/nsite/$SITE_NPUB/app.js" --insecure
fi
check 'Ditto HTTPS web route' "$BASE_HTTPS/" --insecure -H "Host: $DITTO_WEB_HOST"
check 'Ditto WSS NIP-11 route' "$RELAY_HTTPS/" --insecure -H 'Accept: application/nostr+json'
docker-compose -p ncc-bundle -f compose.yaml ps

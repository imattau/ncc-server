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
RELAY_HTTPS="${RELAY_HTTPS:-https://127.0.0.1:8443/relay/}"
SEARCH_UI_HTTPS="${SEARCH_UI_HTTPS:-https://127.0.0.1:8447}"
SEARCH_API_HTTPS="${SEARCH_API_HTTPS:-https://127.0.0.1:8448}"
SITE_NPUB="${SITE_NPUB:-}"
PUBLIC_IPV4="${PUBLIC_IPV4:-127.0.0.1}"
NCC_OPERATOR_PUBKEY="${NCC_OPERATOR_PUBKEY:-}"

check() {
  local label="$1" url="$2"; shift 2
  local code
  code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 "$@" "$url")"
  [[ "$code" == 200 ]] || { echo "$label: HTTP $code" >&2; return 1; }
  echo "$label: HTTP $code"
}

check 'IP HTTP test app route' "$BASE_HTTP/"
check 'Npanel HTTPS dashboard route' "$BASE_HTTPS/api/instance" --insecure \
  -H "X-NCC-Pubkey: $NCC_OPERATOR_PUBKEY" -H 'X-NCC-Service: npanel'
dashboard_json="$(curl --fail --silent --show-error --insecure --max-time 10 \
  -H "X-NCC-Pubkey: $NCC_OPERATOR_PUBKEY" -H 'X-NCC-Service: npanel' \
  "$BASE_HTTPS/api/instance")"
[[ "$dashboard_json" == *"$PUBLIC_IPV4"* ]] || { echo 'Npanel dashboard host did not match.' >&2; exit 1; }
if [[ -n "$SITE_NPUB" ]]; then
  check 'Nsite HTTPS route' "$BASE_HTTPS/nsite/$SITE_NPUB/" --insecure
  check 'Nsite root-relative JavaScript' "$BASE_HTTPS/nsite/$SITE_NPUB/app.js" --insecure
fi
check 'Ditto HTTPS web route' "$BASE_HTTPS/" --insecure \
  -H "X-NCC-Pubkey: $NCC_OPERATOR_PUBKEY" -H 'X-NCC-Service: ditto'
check 'ncc-search HTTPS UI route' "$SEARCH_UI_HTTPS/" --insecure -H "Host: $PUBLIC_IPV4"
check 'ncc-search HTTPS API route' "$SEARCH_API_HTTPS/search?q=a" --insecure -H "Host: $PUBLIC_IPV4"
check 'Ditto WSS NIP-11 route' "$RELAY_HTTPS" --insecure -H 'Accept: application/nostr+json'
docker-compose -p ncc-bundle -f compose.yaml ps

#!/usr/bin/env bash
set -Eeuo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
SIDECAR_URL="${SIDECAR_URL:-http://127.0.0.1:3000}"
CONTENT_CODE="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "$BASE_URL/")"
[[ "$CONTENT_CODE" == 200 ]] || { echo "Content server returned HTTP $CONTENT_CODE" >&2; exit 1; }
curl --fail --silent --max-time 5 "$BASE_URL/" | grep -q 'NCC Server Test' || { echo 'NCC test page content missing' >&2; exit 1; }
SIDECAR_CODE="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "$SIDECAR_URL/api/setup/status")"
[[ "$SIDECAR_CODE" == 200 ]] || { echo "Sidecar admin API returned HTTP $SIDECAR_CODE" >&2; exit 1; }
echo 'Local smoke checks passed. Use make verify NPUB=... to verify relay publication.'


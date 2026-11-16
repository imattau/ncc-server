#!/bin/sh
set -eu

relays_b64="$(printf '%s' "${NCC_SEARCH_RELAYS:-}" | base64 | tr -d '\n')"
printf 'window.NCC_SEARCH_RELAYS_B64 = "%s";\n' "$relays_b64" \
  > /tmp/ncc-search-runtime-config.js

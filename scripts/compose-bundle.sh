#!/usr/bin/env bash
set -Eeuo pipefail
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
args=(docker-compose -p ncc-bundle -f "$PROJECT_DIR/compose.yaml")
while IFS= read -r -d '' fragment; do
  args+=(-f "$fragment")
done < <(find "$PROJECT_DIR/custom-services/packages" -mindepth 2 -maxdepth 2 -name compose.yaml -print0 2>/dev/null | sort -z)
exec "${args[@]}" "$@"

#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_BINARY="${1:-}"

[[ -n "$SOURCE_BINARY" && -x "$SOURCE_BINARY" ]] || {
  echo 'Pass an executable, statically linked npanel binary built from npanel-ncc.' >&2
  exit 2
}
if readelf -l "$SOURCE_BINARY" | grep -q 'program interpreter'; then
  echo "Refusing dynamically linked npanel binary: $SOURCE_BINARY" >&2
  exit 1
fi

install -D -m 0755 "$SOURCE_BINARY" "$PROJECT_DIR/container/npanel/npanel"
"$PROJECT_DIR/container/npanel/npanel" --version
sha256sum "$PROJECT_DIR/container/npanel/npanel"

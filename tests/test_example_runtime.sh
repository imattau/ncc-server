#!/usr/bin/env bash
# Build and smoke-test the example NCC service image.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${NCC_EXAMPLE_PORT:-18083}"
NAME="ncc-hello-example-smoke"
IMAGE="ncc-hello-example:smoke"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ENGINE=(docker)
elif command -v podman >/dev/null 2>&1; then
  ENGINE=(podman)
else
  echo "docker or podman is required for the example smoke test" >&2
  exit 1
fi

cleanup() {
  "${ENGINE[@]}" rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${ENGINE[@]}" build -t "$IMAGE" "$ROOT/examples/hello-service" >/dev/null
"${ENGINE[@]}" rm -f "$NAME" >/dev/null 2>&1 || true
"${ENGINE[@]}" run --rm -d --name "$NAME" \
  --read-only --tmpfs /tmp \
  -p "127.0.0.1:${PORT}:8080" "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "example service served /healthz"
    exit 0
  fi
  sleep 1
done

echo "example service did not become healthy" >&2
"${ENGINE[@]}" logs "$NAME" >&2 || true
exit 1

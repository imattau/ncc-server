#!/usr/bin/env bash
# Smoke-test the custom Compose template's container settings.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${NCC_TEMPLATE_PORT:-18082}"
NAME="ncc-template-smoke"
IMAGE="docker.io/nginxinc/nginx-unprivileged:1.27-alpine"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ENGINE=(docker)
elif command -v podman >/dev/null 2>&1; then
  ENGINE=(podman)
else
  echo "docker or podman is required for the template smoke test" >&2
  exit 1
fi

cleanup() {
  "${ENGINE[@]}" rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${ENGINE[@]}" rm -f "$NAME" >/dev/null 2>&1 || true
"${ENGINE[@]}" run --rm -d --name "$NAME" \
  --read-only --tmpfs /tmp \
  -p "127.0.0.1:${PORT}:8080" "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    echo "template container served HTTP 200"
    exit 0
  fi
  sleep 1
done

echo "template container did not become healthy" >&2
"${ENGINE[@]}" logs "$NAME" >&2 || true
exit 1

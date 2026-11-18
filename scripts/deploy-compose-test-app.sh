#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
[[ -n "$TARGET" ]] || { echo 'Usage: scripts/deploy-compose-test-app.sh user@host' >&2; exit 2; }
[[ -d "$PROJECT_DIR/public" ]] || { echo 'Build the welcome page first: make build-test-app' >&2; exit 2; }
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$PROJECT_DIR/.env"
  set +a
fi
CONTENT_ROOT="${NCC_CONTENT_ROOT:-${CONTENT_ROOT:-/srv/ncc-server/public}}"
CADDY_GID="${CADDY_GID:-996}"
REMOTE_USER="${TARGET%%@*}"
PRIVILEGE='sudo '
if [[ "$REMOTE_USER" == root ]]; then
  PRIVILEGE=''
fi
STAGE=".ncc-test-app-stage-$$"
REMOTE_TTY=()
if [[ "$REMOTE_USER" != root ]]; then
  REMOTE_TTY=(-t)
fi
ssh "$TARGET" "mkdir -p \"\$HOME/$STAGE\""
rsync -a --delete "$PROJECT_DIR/public/" "$TARGET:$STAGE/"
scp -q "$PROJECT_DIR/scripts/publish-web-config.py" "$TARGET:$STAGE-config.py"
ssh "${REMOTE_TTY[@]}" "$TARGET" "${PRIVILEGE}install -d -o root -g '$CADDY_GID' -m 0755 '$CONTENT_ROOT' && ${PRIVILEGE}rsync -a --delete --exclude ncc-config.json \"\$HOME/$STAGE/\" '$CONTENT_ROOT/' && ${PRIVILEGE}chown -R root:'$CADDY_GID' '$CONTENT_ROOT' && ${PRIVILEGE}find '$CONTENT_ROOT' -type d -exec chmod 0755 {} + && ${PRIVILEGE}find '$CONTENT_ROOT' -type f -exec chmod 0644 {} + && ${PRIVILEGE}python3 \"\$HOME/$STAGE-config.py\" --identity-file /etc/ncc-server/operator-identity.json --output '$CONTENT_ROOT/ncc-config.json' --group-id '$CADDY_GID' && rm -rf \"\$HOME/$STAGE\" \"\$HOME/$STAGE-config.py\""
echo "Deployed the welcome page to $TARGET:$CONTENT_ROOT"

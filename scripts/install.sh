#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR_REPO="${NCC_SIDECAR_REPO_URL:-https://github.com/imattau/nostr-community-conventions.git}"
SIDECAR_REV="${NCC_SIDECAR_REV:-186c3ad50966a2319c354ace12e0a5a2267b75d9}"
SIDECAR_SOURCE="${NCC_SIDECAR_SOURCE:-}"
CONFIG_DIR=/etc/ncc-server
CONTENT_ROOT=/srv/ncc-server/public
SIDECAR_TMP=""

die() { echo "Error: $*" >&2; exit 1; }
cleanup() { [[ -z "$SIDECAR_TMP" ]] || rm -rf -- "$SIDECAR_TMP"; }
trap cleanup EXIT

[[ "$(id -u)" -eq 0 ]] || die 'run with sudo or as root'
command -v systemctl >/dev/null || die 'systemd is required'
command -v apt-get >/dev/null || die 'v0.1 installer supports Debian/Ubuntu only'

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg iproute2 rsync git patch openssl

if ! command -v caddy >/dev/null 2>&1; then
  # Use Caddy's signed Debian repository when the distribution archive has no package.
  install -d -m 0755 /usr/share/keyrings
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
fi

if systemctl is-active --quiet ncc-sidecar; then
  echo 'An ncc-sidecar.service is already active; reusing its installation.'
else
  if [[ -z "$SIDECAR_SOURCE" ]]; then
    SIDECAR_TMP="$(mktemp -d /tmp/ncc-server-sidecar.XXXXXX)"
    git clone --filter=blob:none "$SIDECAR_REPO" "$SIDECAR_TMP/source"
    git -C "$SIDECAR_TMP/source" checkout --detach "$SIDECAR_REV"
    SIDECAR_SOURCE="$SIDECAR_TMP/source/ncc-06/ncc-sidecar"
  fi
  [[ -x "$SIDECAR_SOURCE/scripts/install-sidecar.sh" ]] || die "sidecar installer missing under $SIDECAR_SOURCE"
fi

install -d -o root -g caddy -m 0750 "$CONFIG_DIR"
if [[ ! -e "$CONFIG_DIR/ncc-server.env" ]]; then
  install -o root -g root -m 0600 "$PROJECT_DIR/etc/ncc-server.env.example" "$CONFIG_DIR/ncc-server.env"
else
  chown root:root "$CONFIG_DIR/ncc-server.env"
  chmod 0600 "$CONFIG_DIR/ncc-server.env"
fi

if ! getent group caddy >/dev/null; then die 'Caddy package did not create the caddy group'; fi
install -d -o root -g root -m 0755 /var/lib/ncc-sidecar
install -d -o root -g caddy -m 0755 "$CONTENT_ROOT"
rsync -a --chown=root:caddy "$PROJECT_DIR/public/" "$CONTENT_ROOT/"
chown -R root:caddy "$CONTENT_ROOT"
find "$CONTENT_ROOT" -type d -exec chmod 0755 {} +
find "$CONTENT_ROOT" -type f -exec chmod 0644 {} +

install -d -o root -g root -m 0755 /var/log/ncc-server
chown caddy:caddy /var/log/ncc-server
install -d -o root -g root -m 0755 /etc/systemd/system/caddy.service.d
install -o root -g root -m 0644 "$PROJECT_DIR/systemd/caddy-ncc-server.conf" \
  /etc/systemd/system/caddy.service.d/ncc-server.conf
install -o root -g root -m 0644 "$PROJECT_DIR/caddy/Caddyfile" "$CONFIG_DIR/Caddyfile"
if [[ ! -e "$CONFIG_DIR/relay-proxy.caddy" ]]; then
  install -o root -g root -m 0644 /dev/null "$CONFIG_DIR/relay-proxy.caddy"
else
  chown root:root "$CONFIG_DIR/relay-proxy.caddy"
  chmod 0644 "$CONFIG_DIR/relay-proxy.caddy"
fi

if ! systemctl is-active --quiet ncc-sidecar; then
  "$SIDECAR_SOURCE/scripts/install-sidecar.sh" install \
    --install-dir /opt/ncc-sidecar \
    --data-dir /var/lib/ncc-sidecar \
    --service-name ncc-sidecar \
    --service-user ncc-sidecar \
    --port 3000 \
    --repo-source "$SIDECAR_SOURCE"
fi

# The sidecar database contains service signing keys. Keep the persistent data
# directory readable only by the sidecar service account.
install -d -o ncc-sidecar -g ncc-sidecar -m 0700 /var/lib/ncc-sidecar
if [[ -e /var/lib/ncc-sidecar/sidecar.db ]]; then
  chown ncc-sidecar:ncc-sidecar /var/lib/ncc-sidecar/sidecar.db
  chmod 0600 /var/lib/ncc-sidecar/sidecar.db
fi

PUBLISHER=/opt/ncc-sidecar/src/publisher.js
[[ -f "$PUBLISHER" ]] || die "sidecar publisher not found at $PUBLISHER"
if ! grep -q 'Publish timed out waiting for .*relay acknowledgement' "$PUBLISHER"; then
  patch --dry-run -p1 -d /opt/ncc-sidecar < "$PROJECT_DIR/patches/ncc-sidecar-event-ack.patch" \
    || die 'pinned sidecar publisher differs from the reviewed source; refusing to patch'
  patch -p1 -d /opt/ncc-sidecar < "$PROJECT_DIR/patches/ncc-sidecar-event-ack.patch"
fi

TOR_CONTROL=/opt/ncc-sidecar/src/tor-control.js
[[ -f "$TOR_CONTROL" ]] || die "sidecar Tor control module not found at $TOR_CONTROL"
if ! grep -q 'AUTHENTICATE \[REDACTED\]' "$TOR_CONTROL" \
  || ! grep -q 'REDACTED_KEY' "$TOR_CONTROL"; then
  patch --dry-run -p1 -d /opt/ncc-sidecar < "$PROJECT_DIR/patches/ncc-sidecar-tor-auth-log.patch" \
    || die 'pinned sidecar Tor control module differs from the reviewed source; refusing to patch'
  patch -p1 -d /opt/ncc-sidecar < "$PROJECT_DIR/patches/ncc-sidecar-tor-auth-log.patch"
fi

install -d -o root -g root -m 0755 /etc/systemd/system/ncc-sidecar.service.d
install -o root -g root -m 0644 "$PROJECT_DIR/systemd/ncc-sidecar.conf" \
  /etc/systemd/system/ncc-sidecar.service.d/ncc-server.conf

systemctl daemon-reload
systemctl enable caddy.service
systemctl restart caddy.service
systemctl enable ncc-sidecar.service
systemctl restart ncc-sidecar.service

echo 'NCC-Server installed.'
echo 'Next: complete sidecar setup via an SSH tunnel to http://127.0.0.1:3000.'
echo "Content root: $CONTENT_ROOT"
echo 'Review /etc/ncc-server/ncc-server.env before changing the content port.'


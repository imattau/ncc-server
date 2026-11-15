#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR=/opt/ditto-relay
SOURCE_DIR="$INSTALL_DIR/source"
ENV_FILE=/etc/ncc-server/ditto-relay.env
REPOSITORY=https://gitlab.com/soapbox-pub/ditto-relay.git

die() { echo "Error: $*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || die 'run with sudo or as root'
[[ -s "$ENV_FILE" ]] || die 'run make provision-ditto-relay first to create the runtime environment and relay key'
command -v apt-get >/dev/null || die 'this installer supports Debian/Ubuntu only'

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose
install -d -o root -g root -m 0755 "$INSTALL_DIR"
if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  git clone --filter=blob:none "$REPOSITORY" "$SOURCE_DIR"
fi
[[ -f "$SOURCE_DIR/docker-compose.yml" && -f "$SOURCE_DIR/Dockerfile" ]] || die 'Ditto Relay upstream Compose files are missing'

# Debian 12 ships docker-compose v1.29, which rejects the Compose Spec `name`
# key. Set the same project name explicitly on the command line instead.
sed -i '/^name: ditto-relay$/d' "$SOURCE_DIR/docker-compose.yml"

# Keep OpenSearch's memory-mapped index support enabled across reboots.
printf '%s\n' 'vm.max_map_count=262144' > /etc/sysctl.d/99-ditto-relay-opensearch.conf
sysctl --system >/dev/null

ln -sfn "$ENV_FILE" "$SOURCE_DIR/.env"
chown -h root:root "$SOURCE_DIR/.env"
chmod 0600 "$ENV_FILE"
systemctl enable --now docker.service

cd "$SOURCE_DIR"
docker-compose -p ditto-relay config >/dev/null
docker-compose -p ditto-relay up -d --build
git -C "$SOURCE_DIR" rev-parse HEAD > /etc/ncc-server/ditto-relay.revision
chown root:root /etc/ncc-server/ditto-relay.revision
chmod 0644 /etc/ncc-server/ditto-relay.revision

echo 'Ditto Relay and OpenSearch are running from the upstream Compose stack.'
echo "Upstream revision: $(cat /etc/ncc-server/ditto-relay.revision)"
echo 'Relay backend is bound to loopback TCP 13131; TLS is provided by Caddy on 8444.'

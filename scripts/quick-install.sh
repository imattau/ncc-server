#!/usr/bin/env bash
# Bootstraps NCC-Server on a fresh Debian 12 / Ubuntu host in one step.
#
#   curl -fsSL https://raw.githubusercontent.com/imattau/ncc-server/main/scripts/quick-install.sh | sudo bash
#
# This clones (or updates) the project into $NCC_SERVER_DIR and runs the
# Compose installer. It does not replace the Compose bundle's own installer;
# it only automates the "git clone && make install-compose-host" steps from
# the README so they can be run as a single command.
set -Eeuo pipefail

REPO_URL="${NCC_SERVER_REPO:-https://github.com/imattau/ncc-server.git}"
REPO_REF="${NCC_SERVER_REF:-main}"
INSTALL_DIR="${NCC_SERVER_DIR:-/opt/ncc-server}"

die() { echo "Error: $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die 'run as root (e.g. with sudo)'
command -v apt-get >/dev/null || die 'quick-install supports Debian/Ubuntu hosts only'

missing_packages=()
command -v git >/dev/null 2>&1 || missing_packages+=(git)
command -v make >/dev/null 2>&1 || missing_packages+=(make)
if (( ${#missing_packages[@]} )); then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing_packages[@]}"
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Found an existing checkout at $INSTALL_DIR; fetching the latest $REPO_REF."
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$REPO_REF"
  git -C "$INSTALL_DIR" checkout --force --detach FETCH_HEAD
elif [[ -e "$INSTALL_DIR" ]]; then
  die "$INSTALL_DIR already exists and is not a git checkout; remove it or set NCC_SERVER_DIR to a different path"
else
  install -d -m 0755 "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
exec make install-compose-host

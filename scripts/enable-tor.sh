#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_RECORD_ID="${1:-}"
TARGET_PORT="${2:-8080}"
API_URL="${NCC_SIDECAR_API_URL:-http://127.0.0.1:3000}"

die() { echo "Error: $*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || die 'run with sudo or as root'
[[ "$SERVICE_RECORD_ID" =~ ^[0-9]+$ ]] || die 'provide the numeric sidecar service record ID'
[[ "$TARGET_PORT" =~ ^[0-9]+$ ]] && (( TARGET_PORT > 0 && TARGET_PORT < 65536 )) || die 'target port must be 1-65535'
[[ -f /opt/ncc-sidecar/src/tor-control.js ]] || die 'install the pinned sidecar first'
grep -q 'AUTHENTICATE \[REDACTED\]' /opt/ncc-sidecar/src/tor-control.js \
  || die 'sidecar Tor password log-redaction patch is missing; rerun the updated NCC-Server installer'
grep -q 'REDACTED_KEY' /opt/ncc-sidecar/src/tor-control.js \
  || die 'sidecar onion-key log-redaction patch is missing; rerun the updated NCC-Server installer'

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y tor

python3 - "$SERVICE_RECORD_ID" "$TARGET_PORT" "$API_URL" <<'PY'
import json
import pathlib
import re
import secrets
import subprocess
import sys
import time
import urllib.request

record_id, target_port, api_url = sys.argv[1], int(sys.argv[2]), sys.argv[3].rstrip("/")
torrc = pathlib.Path("/etc/tor/torrc")
lines = torrc.read_text().splitlines() if torrc.exists() else []
lines = [line for line in lines if not re.match(r"^\s*(ControlPort|CookieAuthentication|HashedControlPassword)\b", line)]
password = secrets.token_urlsafe(48)
hashed = subprocess.run(["tor", "--hash-password", password], check=True, capture_output=True, text=True).stdout.strip().splitlines()[-1]
lines.extend([
    "",
    "# NCC sidecar control is bound to loopback.",
    "ControlPort 127.0.0.1:9051",
    "CookieAuthentication 0",
    "HashedControlPassword " + hashed,
])
torrc.write_text("\n".join(lines) + "\n")

def request(path, method="GET", data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(api_url + path, data=body, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)

services = request("/api/services")
service = next((item for item in services if str(item.get("id")) == record_id), None)
if service is None:
    raise SystemExit("No sidecar service has record ID " + record_id)
config = service.get("config") or {}
config.setdefault("protocols", {})["tor"] = True
config["local_port"] = target_port
config["tor_control"] = {
    "enabled": True,
    "host": "127.0.0.1",
    "port": 9051,
    "password": password,
}
request("/api/service/" + record_id, method="PUT", data={"config": config})

subprocess.run(["systemctl", "enable", "tor@default"], check=True, capture_output=True, text=True)
subprocess.run(["systemctl", "restart", "tor@default"], check=True, capture_output=True, text=True)
subprocess.run(["systemctl", "restart", "ncc-sidecar"], check=True, capture_output=True, text=True)
for attempt in range(30):
    try:
        result = request("/api/services/republish", method="POST", data={})
        break
    except Exception:
        if attempt == 29:
            raise
        time.sleep(1)
if not result.get("success"):
    raise SystemExit("The sidecar did not confirm a successful republish")
print("Tor enabled for service record " + record_id + "; onion target port " + str(target_port) + ".")
print("No router port forwarding is required for the onion service.")
PY

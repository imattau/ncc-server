#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
IDENTITY_FILE="${NCC_IDENTITY_FILE:-/etc/ncc-server/operator-identity.json}"
die() { echo "Error: $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die 'run as root on the Docker host'
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE is missing; run make install-compose-host first"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose -p ncc-bundle -f "$PROJECT_DIR/compose.yaml")
else
  COMPOSE=(docker-compose -p ncc-bundle -f "$PROJECT_DIR/compose.yaml")
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
[[ -n "${PUBLIC_IPV4:-}" ]] || die 'PUBLIC_IPV4 must be set in .env'

wait_healthy() {
  local service="$1" timeout="${2:-240}" deadline id state
  deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    id="$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null || true)"
    if [[ -n "$id" ]]; then
      state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
      [[ "$state" == healthy ]] && return 0
      [[ "$state" == exited || "$state" == dead ]] && die "$service container stopped before becoming healthy"
    fi
    sleep 2
  done
  die "$service did not become healthy within ${timeout}s"
}

api_initialized() {
  curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3000/api/setup/status \
    | python3 -c 'import json,sys; print("true" if json.load(sys.stdin).get("initialized") else "false")'
}

container_pubkey_for_identity() {
  "${COMPOSE[@]}" exec -T sidecar node --input-type=module -e '
    import { getPublicKey, nip19 } from "nostr-tools";
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const value = JSON.parse(input);
    const decoded = nip19.decode(value.nsec);
    if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) throw new Error("invalid nsec");
    const pubkey = getPublicKey(decoded.data);
    if (value.pubkey !== pubkey || value.npub !== nip19.npubEncode(pubkey)) throw new Error("identity keys do not match");
    process.stdout.write(pubkey);
  '
}

container_services_match_identity() {
  "${COMPOSE[@]}" exec -T sidecar node --input-type=module -e '
    import { getPublicKey, nip19 } from "nostr-tools";
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const identity = JSON.parse(input);
    const expected = getPublicKey(nip19.decode(identity.nsec).data);
    const response = await fetch("http://127.0.0.1:3000/api/services");
    if (!response.ok) throw new Error("could not read current service records");
    const services = await response.json();
    const matches = services.length > 0 && services.every((service) => {
      const decoded = nip19.decode(service.service_nsec);
      return decoded.type === "nsec" && getPublicKey(decoded.data) === expected;
    });
    process.stdout.write(matches ? "true" : "false");
  '
}

generate_identity() {
  local temp
  temp="$(mktemp "$(dirname "$IDENTITY_FILE")/.operator-identity.XXXXXX")"
  if ! "${COMPOSE[@]}" exec -T sidecar node --input-type=module -e '
    import { getPublicKey, generateSecretKey, nip19 } from "nostr-tools";
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    process.stdout.write(JSON.stringify({ format: 1, nsec: nip19.nsecEncode(secret), npub: nip19.npubEncode(pubkey), pubkey }) + "\n");
  ' > "$temp"; then
    rm -f "$temp"
    die 'could not generate the operator keypair in the sidecar image'
  fi
  chmod 0600 "$temp"
  chown root:root "$temp"
  mv -n "$temp" "$IDENTITY_FILE"
  rm -f "$temp"
}

import_identity() {
  local source_file="$1" temp
  [[ -f "$source_file" ]] || die "identity file does not exist: $source_file"
  temp="$(mktemp "$(dirname "$IDENTITY_FILE")/.operator-identity.XXXXXX")"
  if ! install -m 0600 "$source_file" "$temp"; then
    rm -f "$temp"
    die 'could not copy the selected identity file'
  fi
  if ! container_pubkey_for_identity < "$temp" >/dev/null; then
    rm -f "$temp"
    die 'identity file must be JSON with matching nsec, npub, and pubkey values'
  fi
  chown root:root "$temp"
  mv -n "$temp" "$IDENTITY_FILE"
  rm -f "$temp"
  echo "Imported the existing operator identity from $source_file."
}

select_identity() {
  local choice source_file
  if [[ -n "${NCC_IMPORT_IDENTITY_FILE:-}" ]]; then
    import_identity "$NCC_IMPORT_IDENTITY_FILE"
    return
  fi
  if [[ -t 0 ]]; then
    read -r -p 'Operator identity: [g]enerate new or [i]mport existing JSON? [g] ' choice
    case "${choice,,}" in
      i|import)
        read -r -p 'Path to existing identity JSON on this host: ' source_file
        [[ -n "$source_file" ]] || die 'an identity file path is required for import'
        import_identity "$source_file"
        return
        ;;
      ''|g|generate)
        ;;
      *) die 'choose "generate" or "import"' ;;
    esac
  fi
  generate_identity
  echo "Generated and saved the operator keypair at $IDENTITY_FILE (root-only, mode 0600)."
}

echo 'Starting the identity-independent Compose services...'
"${COMPOSE[@]}" up -d tor sidecar opensearch npanel ditto-web search search-ui
for service in sidecar opensearch npanel ditto-web search search-ui; do
  wait_healthy "$service"
done

install -d -o root -g root -m 0700 "$(dirname "$IDENTITY_FILE")"
initialized="$(api_initialized)"
if [[ ! -s "$IDENTITY_FILE" ]]; then
  [[ "$initialized" == false ]] || die "sidecar is already initialized but $IDENTITY_FILE is missing; restore the existing operator identity instead of generating a new one"
  select_identity
fi
chmod 0600 "$IDENTITY_FILE"
chown root:root "$IDENTITY_FILE"
operator_pubkey="$(container_pubkey_for_identity < "$IDENTITY_FILE")" \
  || die 'the saved operator identity is invalid or its keys do not match'

configured_pubkey="$(python3 - "$ENV_FILE" <<'PY'
import pathlib, sys
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if line.startswith('NCC_OPERATOR_PUBKEY='):
        print(line.split('=', 1)[1].strip().strip('"\''))
        break
PY
)"
if [[ "$initialized" == true && -n "$configured_pubkey" && "$configured_pubkey" != "$operator_pubkey" ]]; then
  die 'the saved identity differs from the initialized Compose identity; use the explicit identity migration flow'
fi
export NCC_OPERATOR_PUBKEY="$operator_pubkey"

if [[ "$initialized" == true && -z "$configured_pubkey" ]]; then
  services_match="$(container_services_match_identity < "$IDENTITY_FILE")" \
    || die 'could not verify the existing service identities against the saved operator key'
  [[ "$services_match" == true ]] || die 'existing service records use a different key; run the explicit identity migration flow'
fi

if [[ "$initialized" == false || -z "$configured_pubkey" ]]; then
  echo 'Initializing the sidecar with the saved operator identity...'
  NCC_IDENTITY_FILE="$IDENTITY_FILE" python3 "$PROJECT_DIR/scripts/apply-shared-identity.py" \
    --project-dir "$PROJECT_DIR" < "$IDENTITY_FILE"
fi

echo 'Creating and publishing the standard NCC service records...'
NCC_IDENTITY_FILE="$IDENTITY_FILE" python3 "$PROJECT_DIR/scripts/provision-compose-services.py"

# The provisioner now has the shared certificate and all service profiles.
# Compose re-reads .env here, including the operator pubkey saved above.
"${COMPOSE[@]}" config >/dev/null
"${COMPOSE[@]}" up -d
for service in sidecar opensearch relay npanel ditto-web search search-ui caddy; do
  wait_healthy "$service"
done

echo "Operator npub: $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["npub"])' "$IDENTITY_FILE")"
echo 'Fresh Compose setup is complete. Core NCC services use TCP 8443.'

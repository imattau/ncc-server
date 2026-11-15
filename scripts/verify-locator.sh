#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NPUB="${1:-}"
SERVICE="${2:-web}"
shift $(( $# > 0 ? 1 : 0 )) || true
shift $(( $# > 0 ? 1 : 0 )) || true
RELAYS=("$@")
SIDECAR_DIR="${NCC_SIDECAR_DIR:-/opt/ncc-sidecar}"
NODE_BIN="${NCC_NODE_BIN:-$SIDECAR_DIR/.node/bin/node}"
MODULE_DIR="$SIDECAR_DIR"

[[ -n "$NPUB" ]] || { echo 'Usage: verify-locator.sh <npub-or-hex> [service] [relay ...]' >&2; exit 2; }
if [[ ! -d "$MODULE_DIR/node_modules/nostr-tools" && -d "$PROJECT_DIR/test-app/node_modules/nostr-tools" ]]; then
  MODULE_DIR="$PROJECT_DIR/test-app"
  NODE_BIN="${NCC_NODE_BIN:-$(command -v node || true)}"
fi
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || { echo 'Node.js is required.' >&2; exit 2; }
[[ -d "$MODULE_DIR/node_modules/nostr-tools" ]] || {
  echo 'nostr-tools not found. On a workstation, run npm --prefix test-app ci.' >&2
  exit 2
}
if (( ${#RELAYS[@]} == 0 )); then RELAYS=(wss://relay.primal.net wss://relay.ditto.pub); fi

export NCC_VERIFY_NPUB="$NPUB" NCC_VERIFY_SERVICE="$SERVICE"
export NCC_VERIFY_RELAYS="$(IFS=,; echo "${RELAYS[*]}")"
cd "$MODULE_DIR"
"$NODE_BIN" --input-type=module <<'NODE'
import { SimplePool, nip19, verifyEvent } from 'nostr-tools';

const input = process.env.NCC_VERIFY_NPUB;
let author;
try {
  author = /^[0-9a-f]{64}$/i.test(input) ? input.toLowerCase() : nip19.decode(input).data;
} catch {
  console.error('Invalid npub or 64-character public key.');
  process.exit(2);
}
if (typeof author !== 'string' || !/^[0-9a-f]{64}$/i.test(author)) {
  console.error('Input did not decode to a public key.');
  process.exit(2);
}

const service = process.env.NCC_VERIFY_SERVICE;
const relays = process.env.NCC_VERIFY_RELAYS.split(',').filter(Boolean);
const candidates = [...new Set([`${service}-locator`, service, 'addr'])];
const pool = new SimplePool();
let events;
try {
  events = await Promise.race([
    pool.querySync(relays, { kinds: [30058], authors: [author], '#d': candidates, limit: 20 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('relay query timed out')), 15000))
  ]);
} finally {
  pool.close(relays);
}

const now = Math.floor(Date.now() / 1000);
const matches = events.filter((event) => {
  if (event.kind !== 30058 || event.pubkey !== author || !verifyEvent(event)) return false;
  const d = event.tags.find((tag) => tag[0] === 'd')?.[1];
  if (!candidates.includes(d)) return false;
  let payload;
  try { payload = JSON.parse(event.content); } catch { return false; }
  if (!Array.isArray(payload.endpoints) || !Number.isFinite(Number(payload.ttl)) || !Number.isFinite(Number(payload.updated_at))) return false;
  const expirationTag = Number(event.tags.find((tag) => tag[0] === 'expiration')?.[1]);
  const expiry = Math.min(payload.updated_at + payload.ttl, expirationTag > 0 ? expirationTag : Infinity);
  return expiry > now;
}).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));

if (!matches.length) {
  console.error(`No fresh, valid public locator found for ${service} on ${relays.join(', ')}.`);
  process.exit(1);
}
const event = matches[0];
const payload = JSON.parse(event.content);
console.log(`Verified fresh Kind 30058 locator: ${event.id}`);
console.log(`Author: ${event.pubkey}`);
console.log(`d tag: ${event.tags.find((tag) => tag[0] === 'd')?.[1]}`);
console.log(`Endpoints: ${payload.endpoints.length}`);
for (const endpoint of payload.endpoints) console.log(`  ${endpoint.url ?? endpoint.uri ?? JSON.stringify(endpoint)}`);
NODE


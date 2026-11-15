import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { finalizeEvent, getPublicKey, nip19 } from '../test-app/node_modules/nostr-tools/lib/esm/index.js';

const projectDir = resolve(import.meta.dirname, '..');
const identityPath = resolve(projectDir, 'test-app/.secrets/ncc-test-key.json');
const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
const decoded = nip19.decode(identity.nsec);

if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array)) {
  throw new Error('The saved NCC test identity does not contain a valid nsec.');
}

const derivedNpub = nip19.npubEncode(getPublicKey(decoded.data));
if (derivedNpub !== identity.npub) throw new Error('The saved npub does not match the saved nsec.');

const endpointInput = process.env.NCC_TEST_ENDPOINT;
if (!endpointInput) throw new Error('Set NCC_TEST_ENDPOINT to the endpoint served by the test VM.');

const endpoint = new URL(endpointInput);
if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
  throw new Error('NCC_TEST_ENDPOINT must be an HTTP or HTTPS URL without credentials.');
}

const endpointKey = process.env.NCC_TEST_K?.trim();
if (endpointKey && !/^[A-Za-z0-9_-]{43}$/.test(endpointKey)) {
  throw new Error('NCC_TEST_K must be a 43-character base64url SPKI fingerprint.');
}

const identifier = process.env.NCC_TEST_D?.trim() || 'web-locator';
if (!/^[A-Za-z0-9._:-]{1,128}$/.test(identifier)) {
  throw new Error('NCC_TEST_D must be a short Nostr replaceable-event identifier.');
}

const ttl = Number(process.env.NCC_TEST_TTL ?? 3600);
if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) {
  throw new Error('NCC_TEST_TTL must be an integer between 60 and 86400 seconds.');
}

const relays = (process.env.NCC_TEST_RELAYS ?? 'wss://relay.primal.net/,wss://nos.lol/')
  .split(',').map((relay) => relay.trim()).filter(Boolean);
const createdAt = Math.floor(Date.now() / 1000);
const event = finalizeEvent({
  kind: 30058,
  created_at: createdAt,
  tags: [
    ['d', identifier],
    ['expiration', String(createdAt + ttl)],
  ],
  content: JSON.stringify({
    ttl,
    updated_at: createdAt,
    endpoints: [{
      url: endpoint.toString(),
      protocol: endpoint.protocol.slice(0, -1),
      family: 'ipv4',
      priority: 1,
      ...(endpointKey ? { k: endpointKey } : {}),
    }],
  }),
}, decoded.data);

async function publishToRelay(relayUrl) {
  await new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(relayUrl);
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${relayUrl}`)), 10000);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) rejectPromise(error);
      else resolvePromise();
    }

    socket.addEventListener('open', () => socket.send(JSON.stringify(['EVENT', event])));
    socket.addEventListener('message', (message) => {
      let response;
      try { response = JSON.parse(String(message.data)); } catch { return; }
      if (!Array.isArray(response) || response[0] !== 'OK' || response[1] !== event.id) return;
      finish(response[2] === true ? null : new Error(`${relayUrl} rejected event: ${response[3] ?? 'no reason supplied'}`));
    });
    socket.addEventListener('error', () => finish(new Error(`WebSocket error from ${relayUrl}`)));
    socket.addEventListener('close', () => {
      if (!settled) finish(new Error(`${relayUrl} closed before acknowledging the event`));
    });
  });
}

const outcomes = await Promise.allSettled(relays.map(publishToRelay));
const successes = outcomes.flatMap((outcome, index) => outcome.status === 'fulfilled' ? [relays[index]] : []);
for (const [index, outcome] of outcomes.entries()) {
  if (outcome.status === 'rejected') console.error(`${relays[index]}: ${outcome.reason.message}`);
}
if (successes.length === 0) throw new Error('The test locator was not acknowledged by any relay.');

console.log(`Published fresh test locator (${identifier}) for ${identity.npub}`);
console.log(`Endpoint: ${endpoint.toString()}`);
if (endpointKey) console.log(`TLS SPKI pin: ${endpointKey}`);
console.log(`Event: ${event.id}`);
console.log(`Acknowledged by: ${successes.join(', ')}`);

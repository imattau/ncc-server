import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';

const baseUrl = (process.env.SIDECAR_ADMIN_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const identityPath = process.env.NCC_IDENTITY_FILE ?? '/etc/ncc-server/operator-identity.json';
const host = process.env.PUBLIC_IPV4;
const port = Number(process.env.DITTO_WEB_TLS_PORT ?? 8446);
const certDir = process.env.SIDECAR_CERT_DIR ?? '/opt/ncc-sidecar/certs';

if (!isIPv4(host ?? '')) {
  throw new Error('Set PUBLIC_IPV4 to the server public IPv4 address.');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('DITTO_WEB_TLS_PORT must be a valid TCP port.');
}
const publicKey = execFileSync('openssl', ['x509', '-in', join(certDir, '2/server.crt'), '-pubkey', '-noout']);
const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'DER'], { input: publicKey });
const pin = createHash('sha256').update(der).digest('base64url');

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

const endpoint = `https://${host}:${port}/`;
const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
if (!identity.nsec || !identity.npub) throw new Error(`Invalid shared Nostr identity at ${identityPath}`);
const services = await request('/api/services');
let service = services.find((candidate) => candidate.service_id === 'ditto');
const previous = service?.config ?? {};
const config = {
  ...previous,
  refresh_interval_minutes: 360,
  ncc02_expiry_days: 14,
  ncc05_ttl_hours: 12,
  service_mode: previous.service_mode === 'private' ? 'private' : 'public',
  ncc05_recipients: Array.isArray(previous.ncc05_recipients) ? previous.ncc05_recipients : [],
  generate_self_signed: false,
  protocols: { ipv4: true, ipv6: false, tor: false },
  primary_protocol: 'ipv4',
  preferred_protocol: 'https',
  port,
  probe_url: 'http://127.0.0.1:3210/',
  ncc02ExpectedKey: pin,
  endpoints: [{ url: endpoint, family: 'ipv4', protocol: 'https', priority: 1, k: pin }],
};

let npub;
if (service) {
  await request(`/api/service/${service.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Ditto NCC web test',
      config,
      status: 'active',
      ...(previous.service_identity === 'dedicated' ? {} : { service_nsec: identity.nsec }),
    }),
  });
} else {
  npub = identity.npub;
  service = await request('/api/service/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'custom',
      name: 'Ditto NCC web test',
      service_id: 'ditto',
      service_nsec: identity.nsec,
      config,
      state: {},
    }),
  });
}

const result = await request('/api/services/republish', { method: 'POST' });
const published = result.details?.find((detail) => String(detail.serviceId) === String(service.id));
if (!published?.success) throw new Error(published?.error ?? 'Ditto locator republish did not succeed.');

console.log(`Published Ditto web locator for service ID ditto at ${endpoint}`);
if (npub) console.log(`Ditto service npub: ${npub}`);

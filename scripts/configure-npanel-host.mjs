import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';

const baseUrl = (process.env.SIDECAR_ADMIN_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const host = process.env.PUBLIC_IPV4;
const port = Number(process.env.CONTENT_TLS_PORT ?? 8443);
const certDir = process.env.SIDECAR_CERT_DIR ?? '/opt/ncc-sidecar/certs';

if (!isIPv4(host ?? '')) {
  throw new Error('Set PUBLIC_IPV4 to the server public IPv4 address.');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('CONTENT_TLS_PORT must be a valid TCP port.');
}
const publicKey = execFileSync('openssl', ['x509', '-in', join(certDir, '2/server.crt'), '-pubkey', '-noout']);
const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'DER'], { input: publicKey });
const pin = createHash('sha256').update(der).digest('base64url');

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

const services = await request('/api/services');
const service = services.find((candidate) => candidate.service_id === 'npanel' && candidate.status === 'active');
if (!service) throw new Error('No active sidecar service with service_id=npanel was found.');

const endpoint = `https://${host}:${port}/`;
const config = {
  ...service.config,
  preferred_protocol: 'https',
  port,
  probe_url: 'http://127.0.0.1:3200/api/instance',
  ncc02ExpectedKey: pin,
  endpoints: [{ url: endpoint, family: 'ipv4', protocol: 'https', priority: 1, k: pin }],
};

await request(`/api/service/${service.id}`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ config }),
});
const result = await request('/api/services/republish', { method: 'POST' });
const published = result.details?.find((detail) => String(detail.serviceId) === String(service.id));
if (!published?.success) throw new Error(published?.error ?? 'Npanel locator republish did not succeed.');

console.log(`Updated ${service.service_id} locator endpoint to ${endpoint}`);

const baseUrl = (process.env.SIDECAR_ADMIN_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const host = process.env.DITTO_WEB_HOST;
const pin = process.env.DITTO_WEB_K;
const port = Number(process.env.CONTENT_TLS_PORT ?? 8443);

if (!host || !/^[A-Za-z0-9.-]+$/.test(host)) {
  throw new Error('Set DITTO_WEB_HOST to the Ditto test hostname.');
}
if (!pin || !/^[A-Za-z0-9_-]{43}$/.test(pin)) {
  throw new Error('Set DITTO_WEB_K to the existing Caddy certificate SPKI pin.');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('CONTENT_TLS_PORT must be a valid TCP port.');
}

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

const endpoint = `https://${host}:${port}/`;
const config = {
  refresh_interval_minutes: 360,
  ncc02_expiry_days: 14,
  ncc05_ttl_hours: 12,
  service_mode: 'public',
  generate_self_signed: false,
  protocols: { ipv4: true, ipv6: false, tor: false },
  primary_protocol: 'ipv4',
  preferred_protocol: 'https',
  port,
  probe_url: endpoint,
  ncc02ExpectedKey: pin,
  endpoints: [{ url: endpoint, family: 'ipv4', protocol: 'https', priority: 1, k: pin }],
};

const services = await request('/api/services');
let service = services.find((candidate) => candidate.service_id === 'ditto');
let npub;
if (service) {
  await request(`/api/service/${service.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ditto NCC web test', config, status: 'active' }),
  });
} else {
  const keys = await request('/api/service/generate-key');
  npub = keys.npub;
  service = await request('/api/service/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'custom',
      name: 'Ditto NCC web test',
      service_id: 'ditto',
      service_nsec: keys.nsec,
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

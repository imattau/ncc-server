const baseUrl = (process.env.SIDECAR_ADMIN_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const host = process.env.DASHBOARD_HOST;
const port = Number(process.env.CONTENT_PORT ?? 8080);

if (!host || !/^[A-Za-z0-9.-]+$/.test(host)) {
  throw new Error('Set DASHBOARD_HOST to Npanel’s unique hostname.');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('CONTENT_PORT must be a valid TCP port.');
}

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

const services = await request('/api/services');
const service = services.find((candidate) => candidate.service_id === 'npanel' && candidate.status === 'active');
if (!service) throw new Error('No active sidecar service with service_id=npanel was found.');

const endpoint = `http://${host}:${port}/`;
const config = {
  ...service.config,
  preferred_protocol: 'http',
  port,
  probe_url: endpoint,
  endpoints: [{ url: endpoint, family: 'ipv4', protocol: 'http', priority: 1 }],
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

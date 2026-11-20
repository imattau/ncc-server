/**
 * Recreate Compose containers after their image was pulled.
 *
 * This runs in a one-shot helper container, not in node-agent, because
 * updating `node-agent` itself means stopping the process that would
 * otherwise be doing the work. The helper receives only container IDs that
 * node-agent already selected from this Compose project, inspects each one,
 * and copies its existing configuration into a new container with the same
 * name and image reference. Nothing is baked into the helper: options come
 * from Docker's own inspect output, so volumes, ports, host networking and
 * security settings survive the update unchanged.
 *
 * Sequence per container: rename the old one, stop it (freeing its name and
 * ports), create the replacement, start it, then delete the old one. If
 * create or start fails, the new container is removed and the old one is
 * renamed back and started, so a bad image cannot leave the service down.
 *
 * Result: a single stdout line `NCC_RECREATE_RESULT {json}` for node-agent
 * to read, plus a non-zero exit code when any service failed.
 */

/* global Buffer, process */

import http from 'node:http';

const DOCKER_SOCKET = process.env.NCC_DOCKER_SOCKET || '/var/run/docker.sock';
const RESULT_MARKER = 'NCC_RECREATE_RESULT ';
const STOP_TIMEOUT_SECONDS = 10;
const SERVICE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Config fields Docker accepts on create; inspect adds read-only extras. */
const CREATE_CONFIG_FIELDS = [
  'Hostname', 'Domainname', 'User', 'AttachStdin', 'AttachStdout',
  'AttachStderr', 'Tty', 'OpenStdin', 'StdinOnce', 'Env', 'Cmd',
  'Healthcheck', 'ArgsEscaped', 'Image', 'Volumes', 'WorkingDir',
  'Entrypoint', 'NetworkDisabled', 'MacAddress', 'Labels', 'StopSignal',
  'ExposedPorts', 'Shell',
];

function plan() {
  const encoded = process.env.NCC_RECREATE_PLAN || '';
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new Error('NCC_RECREATE_PLAN is not valid base64 JSON');
  }
  const services = Array.isArray(parsed?.services) ? parsed.services : [];
  if (!services.length || services.length > 8) {
    throw new Error('The recreate plan needs between 1 and 8 services');
  }
  for (const entry of services) {
    if (!entry || typeof entry.service !== 'string' || !SERVICE_PATTERN.test(entry.service)) {
      throw new Error('The recreate plan contains an invalid service name');
    }
    if (typeof entry.id !== 'string' || !entry.id) {
      throw new Error(`The recreate plan has no container for ${entry.service}`);
    }
  }
  return services;
}

function dockerRequest(path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath: DOCKER_SOCKET, path, method, headers: { Host: 'docker', ...headers } },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({
          status: response.statusCode || 0,
          body: Buffer.concat(chunks),
        }));
        response.on('error', reject);
      },
    );
    request.setTimeout(30_000, () => request.destroy(new Error(`Docker request timed out: ${method} ${path}`)));
    request.on('error', reject);
    if (body !== undefined) request.end(body);
    else request.end();
  });
}

async function dockerJson(path, options = {}) {
  const response = await dockerRequest(path, options);
  const text = response.body.toString('utf8');
  if (response.status >= 400) {
    throw new Error(`Docker returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Docker returned a non-JSON response');
  }
}

function post(path) {
  return dockerJson(path, { method: 'POST' });
}

function postJson(path, payload) {
  return dockerJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function parseImageRef(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  const at = ref.indexOf('@');
  if (at !== -1) return { name: ref.slice(0, at), tag: null };
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > slash) return { name: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { name: ref, tag: 'latest' };
}

function createConfig(inspect) {
  const source = inspect?.Config;
  if (!source || typeof source.Image !== 'string' || !source.Image) {
    throw new Error('Docker inspect did not return an image reference');
  }

  const config = {};
  for (const field of CREATE_CONFIG_FIELDS) {
    if (source[field] !== undefined && source[field] !== null) config[field] = source[field];
  }
  // Docker gives every container a hostname derived from its ID. Keeping the
  // old short ID would leave the replacement with a stale hostname, so drop
  // it and let Docker derive the new one. A hostname set by Compose stays.
  if (typeof inspect?.Id === 'string' && config.Hostname === inspect.Id.slice(0, 12)) {
    delete config.Hostname;
  }

  const response = { ...config, HostConfig: inspect.HostConfig || {} };

  // `network_mode: host`, `none` and `container:…` have no endpoint config;
  // a user-defined bridge needs its aliases restored.
  const mode = String(response.HostConfig.NetworkMode || '');
  if (mode !== 'host' && mode !== 'none' && !mode.startsWith('container:')) {
    const endpoints = {};
    for (const [network, settings] of Object.entries(inspect.NetworkSettings?.Networks || {})) {
      endpoints[network] = {
        Aliases: settings?.Aliases,
        IPAMConfig: settings?.IPAMConfig,
        Links: settings?.Links,
      };
    }
    if (Object.keys(endpoints).length) response.NetworkingConfig = { EndpointsConfig: endpoints };
  }

  return response;
}

async function recreate(entry) {
  const inspect = await dockerJson(`/containers/${encodeURIComponent(entry.id)}/json`);
  const name = typeof inspect?.Name === 'string' ? inspect.Name.replace(/^\//, '') : '';
  if (!name) throw new Error('Docker inspect did not return a container name');

  const config = createConfig(inspect);
  const backupName = `${name}-ncc-old-${Date.now().toString(36)}`;

  await post(`/containers/${encodeURIComponent(entry.id)}/rename?name=${encodeURIComponent(backupName)}`);
  try {
    await post(`/containers/${encodeURIComponent(entry.id)}/stop?t=${STOP_TIMEOUT_SECONDS}`);
  } catch (error) {
    await post(`/containers/${encodeURIComponent(entry.id)}/rename?name=${encodeURIComponent(name)}`)
      .catch(() => {});
    throw error;
  }

  let replacementId = null;
  try {
    const created = await postJson(
      `/containers/create?name=${encodeURIComponent(name)}`,
      config,
    );
    replacementId = typeof created?.Id === 'string' ? created.Id : null;
    if (!replacementId) throw new Error('Docker did not return the new container ID');
    await post(`/containers/${encodeURIComponent(replacementId)}/start`);
  } catch (error) {
    if (replacementId) {
      await dockerJson(`/containers/${encodeURIComponent(replacementId)}?force=1&v=0`, { method: 'DELETE' })
        .catch(() => {});
    }
    await post(`/containers/${encodeURIComponent(entry.id)}/rename?name=${encodeURIComponent(name)}`)
      .catch(() => {});
    await post(`/containers/${encodeURIComponent(entry.id)}/start`).catch(() => {});
    throw error;
  }

  // Volumes are kept: `v=0` is deliberate. Named volumes belong to Compose,
  // and an update must never remove the service's data.
  await dockerJson(`/containers/${encodeURIComponent(entry.id)}?force=1&v=0`, { method: 'DELETE' })
    .catch((error) => {
      console.warn(`[recreate] could not remove the previous ${name}: ${error.message}`);
    });

  console.log(`[recreate] ${entry.service}: ${name} now runs ${parseImageRef(config.Image)?.tag ?? config.Image}`);
}

async function main() {
  const services = plan();
  const results = [];

  for (const entry of services) {
    try {
      await recreate(entry);
      results.push({ service: entry.service, ok: true, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'recreate failed';
      console.error(`[recreate] ${entry.service}: ${message}`);
      results.push({ service: entry.service, ok: false, error: message });
    }
  }

  console.log(`${RESULT_MARKER}${JSON.stringify({ services: results })}`);
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}

main().catch((error) => {
  console.error(`[recreate] ${error instanceof Error ? error.message : 'recreate failed'}`);
  process.exitCode = 1;
});

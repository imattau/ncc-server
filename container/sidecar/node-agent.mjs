/**
 * Narrow Docker control plane for the NCC admin panel.
 *
 * The sidecar is deliberately hardened and has no Docker access. This small
 * companion process runs with the sidecar image, mounts the Docker socket,
 * and exposes only three operations for containers in this Compose project:
 * read container state, read recent logs, and restart a named service.
 *
 * It is not a general Docker proxy. Every request names Compose services,
 * and the agent resolves them through the `com.docker.compose.project` label,
 * so a caller cannot address another project or an arbitrary container.
 *
 * Transport is host loopback plus a bearer token. The sidecar is the only
 * caller. `GET /health` is unauthenticated so Compose can probe the process.
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const DOCKER_SOCKET = process.env.NCC_DOCKER_SOCKET || '/var/run/docker.sock';
const PROJECT = process.env.NCC_COMPOSE_PROJECT || 'ncc-bundle';
const HOST = process.env.NCC_AGENT_HOST || '127.0.0.1';
const PORT = Number(process.env.NCC_AGENT_PORT || 3010);
const TOKEN = process.env.NCC_AGENT_TOKEN || '';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_LINES = 500;
const MAX_CONTAINERS = 50;
const SERVICE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

if (!TOKEN) {
  console.warn('[node-agent] NCC_AGENT_TOKEN is not set; container controls are disabled');
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function authorized(request) {
  if (!TOKEN) return false;
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length).trim());
  const expected = Buffer.from(TOKEN);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new Error('Request body must be JSON'));
      }
    });
    request.on('error', reject);
  });
}

function dockerRequest(path, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath: DOCKER_SOCKET, path, method, headers: { Host: 'docker' } },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          // Logs are capped by Docker's tail parameter; other responses are
          // small. Protect the process from an unexpected body.
          if (size > 8 * 1024 * 1024) {
            reject(new Error('Docker response is too large'));
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve({
          status: response.statusCode || 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
        response.on('error', reject);
      },
    );
    request.setTimeout(15_000, () => {
      request.destroy(new Error('Docker request timed out'));
    });
    request.on('error', reject);
    request.end();
  });
}

async function dockerJson(path, options) {
  const response = await dockerRequest(path, options);
  if (response.status >= 400) {
    const detail = response.body.toString('utf8').slice(0, 300);
    throw new Error(`Docker returned HTTP ${response.status}: ${detail}`);
  }
  try {
    return JSON.parse(response.body.toString('utf8') || 'null');
  } catch {
    throw new Error('Docker returned a non-JSON response');
  }
}

function composeService(container) {
  const labels = container.Labels || {};
  if (labels['com.docker.compose.project'] !== PROJECT) return null;
  const name = labels['com.docker.compose.service'];
  return typeof name === 'string' && SERVICE_PATTERN.test(name) ? name : null;
}

async function projectContainers() {
  const filters = encodeURIComponent(JSON.stringify({
    label: [`com.docker.compose.project=${PROJECT}`],
  }));
  const list = await dockerJson(`/containers/json?all=1&filters=${filters}`);
  if (!Array.isArray(list)) return [];

  const containers = [];
  for (const entry of list.slice(0, MAX_CONTAINERS)) {
    const service = composeService(entry);
    if (!service || typeof entry.Id !== 'string') continue;
    containers.push({
      service,
      id: entry.Id,
      name: (Array.isArray(entry.Names) && entry.Names[0] ? entry.Names[0] : entry.Id).replace(/^\//, ''),
      state: entry.State || 'unknown',
      status: entry.Status || '',
      health: null,
      restartCount: 0,
      startedAt: null,
    });
  }

  await Promise.all(containers.map(async (container) => {
    try {
      const detail = await dockerJson(`/containers/${container.id}/json`);
      const state = detail?.State || {};
      container.state = state.Status || container.state;
      container.health = state.Health?.Status || null;
      container.restartCount = Number.isInteger(detail?.RestartCount) ? detail.RestartCount : 0;
      container.startedAt = state.StartedAt || null;
    } catch {
      // The list view is enough when inspect fails; do not fail the request.
    }
  }));

  return containers;
}

function selectContainers(containers, services) {
  const selected = [];
  const missing = [];
  for (const service of services) {
    const matches = containers.filter((container) => container.service === service);
    if (!matches.length) missing.push(service);
    selected.push(...matches);
  }
  return { selected, missing };
}

function parseServiceList(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const services = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!services.length || services.length > MAX_CONTAINERS) return null;
  if (services.some((service) => !SERVICE_PATTERN.test(service))) return null;
  return [...new Set(services)];
}

/** Split Docker's multiplexed (non-TTY) log stream into lines. */
function decodeDockerLogs(buffer) {
  const chunks = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);
    // A raw (TTY) stream does not start with a valid 1/2 stream byte and a
    // sane frame length; treat the remainder as one chunk in that case.
    if ((stream !== 1 && stream !== 2) || length > buffer.length - offset - 8) break;
    const payload = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push({ stream: stream === 2 ? 'stderr' : 'stdout', text: payload.toString('utf8') });
    offset += 8 + length;
  }

  if (!chunks.length) {
    chunks.push({ stream: 'stdout', text: buffer.toString('utf8') });
  } else if (offset < buffer.length) {
    chunks.push({ stream: 'stdout', text: buffer.subarray(offset).toString('utf8') });
  }

  const lines = [];
  for (const chunk of chunks) {
    for (const line of chunk.text.split('\n')) {
      if (!line) continue;
      const match = /^(\d{4}-\d{2}-\d{2}T\S+)\s(.*)$/.exec(line);
      lines.push({
        stream: chunk.stream,
        timestamp: match ? match[1] : null,
        message: match ? match[2] : line,
      });
    }
  }
  return lines;
}

async function containerLogs(container, tail) {
  const response = await dockerRequest(
    `/containers/${container.id}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`,
  );
  if (response.status >= 400) {
    throw new Error(`Docker returned HTTP ${response.status}`);
  }
  return decodeDockerLogs(response.body).map((line) => ({
    ...line,
    service: container.service,
    container: container.name,
  }));
}

function logTime(line) {
  if (!line.timestamp) return 0;
  const value = Date.parse(line.timestamp);
  return Number.isFinite(value) ? value : 0;
}

async function handleContainers(request, response, url) {
  const requested = parseServiceList(url.searchParams.get('services'));
  const containers = await projectContainers();
  const filtered = requested
    ? containers.filter((container) => requested.includes(container.service))
    : containers;
  sendJson(response, 200, { project: PROJECT, containers: filtered });
}

async function handleLogs(request, response, url) {
  const services = parseServiceList(url.searchParams.get('services'));
  if (!services) {
    sendJson(response, 400, { error: 'services must be a comma-separated list of Compose service names' });
    return;
  }
  const tail = Math.min(
    Math.max(Number.parseInt(url.searchParams.get('tail') || '200', 10) || 200, 1),
    MAX_LOG_LINES,
  );

  const containers = await projectContainers();
  const { selected, missing } = selectContainers(containers, services);
  if (missing.length) {
    sendJson(response, 404, { error: `No container for: ${missing.join(', ')}` });
    return;
  }

  const logs = [];
  for (const container of selected) {
    try {
      logs.push(...await containerLogs(container, tail));
    } catch (error) {
      logs.push({
        service: container.service,
        container: container.name,
        stream: 'stderr',
        timestamp: null,
        message: `Could not read container logs: ${error.message}`,
      });
    }
  }

  logs.sort((left, right) => logTime(right) - logTime(left));
  sendJson(response, 200, {
    project: PROJECT,
    containers: selected.map((container) => ({
      service: container.service,
      name: container.name,
      state: container.state,
    })),
    logs: logs.slice(0, tail),
  });
}

async function handleRestart(request, response) {
  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  const services = Array.isArray(body.services) ? body.services : null;
  if (!services || !services.length || services.length > MAX_CONTAINERS
      || services.some((service) => typeof service !== 'string' || !SERVICE_PATTERN.test(service))) {
    sendJson(response, 400, { error: 'services must be a non-empty array of Compose service names' });
    return;
  }

  const containers = await projectContainers();
  const { selected, missing } = selectContainers(containers, [...new Set(services)]);
  if (missing.length) {
    sendJson(response, 404, { error: `No container for: ${missing.join(', ')}` });
    return;
  }

  // Respond before touching the containers. Restarting caddy would otherwise
  // cut the response to the panel that is proxied through it.
  sendJson(response, 202, {
    accepted: true,
    containers: selected.map((container) => ({
      service: container.service,
      name: container.name,
      state: container.state,
    })),
  });

  setTimeout(() => {
    for (const container of selected) {
      dockerRequest(`/containers/${container.id}/restart?t=10`, { method: 'POST' })
        .then((result) => {
          if (result.status >= 400) {
            console.warn(`[node-agent] restart ${container.name} returned HTTP ${result.status}`);
          } else {
            console.log(`[node-agent] restarted ${container.name} (${container.service})`);
          }
        })
        .catch((error) => {
          console.warn(`[node-agent] restart ${container.name} failed: ${error.message}`);
        });
    }
  }, 600);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true, project: PROJECT });
    return;
  }

  if (!authorized(request)) {
    sendJson(response, 401, { error: 'Missing or invalid node-agent token' });
    return;
  }

  try {
    if (request.method === 'GET' && url.pathname === '/v1/containers') {
      await handleContainers(request, response, url);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/logs') {
      await handleLogs(request, response, url);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/restart') {
      await handleRestart(request, response);
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(response, 503, { error: error instanceof Error ? error.message : 'Docker is unavailable' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[node-agent] listening on http://${HOST}:${PORT} for project ${PROJECT}`);
});

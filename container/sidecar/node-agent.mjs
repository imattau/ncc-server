/**
 * Narrow Docker control plane for the NCC admin panel.
 *
 * The sidecar is deliberately hardened and has no Docker access. This small
 * companion process runs with the sidecar image, mounts the Docker socket,
 * and exposes only four operations: read container state, read recent logs,
 * restart a named service, and read host resource metrics. Container
 * operations are limited to this Compose project.
 *
 * It is not a general Docker proxy. Every request names Compose services,
 * and the agent resolves them through the `com.docker.compose.project` label,
 * so a caller cannot address another project or an arbitrary container.
 *
 * Transport is host loopback plus a bearer token. The sidecar is the only
 * caller. `GET /health` is unauthenticated so Compose can probe the process.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { timingSafeEqual } from 'node:crypto';

const DOCKER_SOCKET = process.env.NCC_DOCKER_SOCKET || '/var/run/docker.sock';
const PROJECT = process.env.NCC_COMPOSE_PROJECT || 'ncc-bundle';
const HOST = process.env.NCC_AGENT_HOST || '127.0.0.1';
const PORT = Number(process.env.NCC_AGENT_PORT || 3010);
const TOKEN = process.env.NCC_AGENT_TOKEN || '';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_LINES = 500;
const MAX_CONTAINERS = 50;
const METRICS_CACHE_MS = 5_000;
const DOCKER_USAGE_CACHE_MS = 60_000;
const CPU_SAMPLE_MS = 200;
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

// --- host metrics ---------------------------------------------------------
//
// The panel's Storage card and Overview resource cards read these values.
// They come from three places, all already available to this process:
// `/proc` (host-wide on a normal Docker host), `statfs('/')` (the overlay's
// backing filesystem, i.e. the host disk Docker stores containers on), and
// Docker's own `/info` and `/system/df`.

let metricsCache = { at: 0, value: null };
let metricsInFlight = null;
let usageCache = { at: 0, value: null };
let usageInFlight = null;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function percent(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.round(Math.min(100, Math.max(0, (used / total) * 100)) * 10) / 10;
}

async function readText(file) {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readCpuTimes() {
  const text = await readText('/proc/stat');
  if (!text) return null;
  const line = text.split('\n')[0] || '';
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  // user, nice, system, idle, iowait, irq, softirq, steal, guest, guest_nice
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return null;
  const idle = values[3] + (values[4] || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  return total > 0 ? { idle, total } : null;
}

/** Host CPU usage over a short sample; null rather than a made-up value. */
async function cpuUsagePercent() {
  const first = await readCpuTimes();
  if (!first) return null;
  await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_MS));
  const second = await readCpuTimes();
  if (!second) return null;
  const total = second.total - first.total;
  const idle = second.idle - first.idle;
  if (total <= 0 || idle < 0) return null;
  return percent(total - idle, total);
}

async function loadAverage() {
  const text = await readText('/proc/loadavg');
  if (!text) return null;
  const [load1, load5, load15] = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (![load1, load5, load15].every(Number.isFinite)) return null;
  return { load1, load5, load15 };
}

async function memoryMetrics() {
  const text = await readText('/proc/meminfo');
  let total = null;
  let available = null;

  if (text) {
    const read = (key) => {
      const match = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
      return match ? Number(match[1]) * 1024 : null;
    };
    total = read('MemTotal');
    available = read('MemAvailable') ?? read('MemFree');
  }
  if (!Number.isFinite(total) || total <= 0) {
    const fallback = os.totalmem();
    total = Number.isFinite(fallback) && fallback > 0 ? fallback : null;
    available = Number.isFinite(os.freemem()) ? os.freemem() : null;
  }
  if (total === null) return null;

  const used = available === null ? null : Math.max(0, total - available);
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: used,
    usedPercent: used === null ? null : percent(used, total),
  };
}

/**
 * Capacity of the filesystem Docker stores containers on. Inside a container
 * `/` is an overlay mount, and overlayfs reports the statistics of its upper
 * layer, which lives under Docker's root directory on the host disk. The
 * Docker socket cannot be used for this: it is bind-mounted from the host's
 * `/run`, which is usually a small tmpfs.
 */
async function storageMetrics() {
  try {
    const stat = await fs.promises.statfs('/');
    const total = Number(stat.bsize) * Number(stat.blocks);
    const free = Number(stat.bsize) * Number(stat.bavail);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free)) return null;
    const used = Math.max(0, total - free);
    return {
      totalBytes: total,
      freeBytes: free,
      usedBytes: used,
      usedPercent: percent(used, total),
    };
  } catch {
    return null;
  }
}

function sumBytes(list, read) {
  if (!Array.isArray(list)) return 0;
  return list.reduce((total, entry) => {
    const value = read(entry);
    return total + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
}

/**
 * Docker's own usage breakdown. `/system/df` walks images, volumes and build
 * cache, so it is cached longer than the cheap host readings.
 */
function dockerUsage() {
  const now = Date.now();
  if (usageCache.value && now - usageCache.at < DOCKER_USAGE_CACHE_MS) {
    return Promise.resolve(usageCache.value);
  }
  if (usageInFlight) return usageInFlight;

  usageInFlight = dockerJson('/system/df')
    .then((df) => {
      const imagesBytes = finiteNumber(df?.LayersSize)
        ?? sumBytes(df?.Images, (entry) => finiteNumber(entry?.Size));
      const containersBytes = sumBytes(df?.Containers, (entry) => finiteNumber(entry?.SizeRw));
      const volumesBytes = sumBytes(df?.Volumes, (entry) => finiteNumber(entry?.UsageData?.Size));
      const buildCacheBytes = sumBytes(df?.BuildCache, (entry) => finiteNumber(entry?.Size));
      const value = {
        imagesBytes,
        containersBytes,
        volumesBytes,
        buildCacheBytes,
        totalBytes: imagesBytes + containersBytes + volumesBytes + buildCacheBytes,
        images: Array.isArray(df?.Images) ? df.Images.length : null,
        containers: Array.isArray(df?.Containers) ? df.Containers.length : null,
        volumes: Array.isArray(df?.Volumes) ? df.Volumes.length : null,
      };
      usageCache = { at: Date.now(), value };
      return value;
    })
    .catch(() => null)
    .finally(() => {
      usageInFlight = null;
    });

  return usageInFlight;
}

async function collectMetrics() {
  const [info, usage, load, memory, storage, usagePercent, uptimeText] = await Promise.all([
    dockerJson('/info').catch(() => null),
    dockerUsage(),
    loadAverage(),
    memoryMetrics(),
    storageMetrics(),
    cpuUsagePercent(),
    readText('/proc/uptime'),
  ]);

  const uptime = uptimeText ? Number(uptimeText.trim().split(/\s+/)[0]) : null;
  const cores = Number.isInteger(info?.NCPU) && info.NCPU > 0
    ? info.NCPU
    : (os.cpus().length || null);

  return {
    collectedAt: Math.floor(Date.now() / 1000),
    host: {
      // Docker reports the host's name; os.hostname() would be the container.
      hostname: typeof info?.Name === 'string' ? info.Name : null,
      kernel: typeof info?.KernelVersion === 'string' ? info.KernelVersion : null,
      os: typeof info?.OperatingSystem === 'string' ? info.OperatingSystem : null,
      dockerVersion: typeof info?.ServerVersion === 'string' ? info.ServerVersion : null,
      uptimeSeconds: Number.isFinite(uptime) ? Math.round(uptime) : null,
    },
    cpu: {
      cores,
      load1: load?.load1 ?? null,
      load5: load?.load5 ?? null,
      load15: load?.load15 ?? null,
      usagePercent,
    },
    memory,
    storage,
    docker: usage,
  };
}

/** One collection at a time, reused for a few seconds across panel reads. */
function cachedMetrics() {
  const now = Date.now();
  if (metricsCache.value && now - metricsCache.at < METRICS_CACHE_MS) {
    return Promise.resolve(metricsCache.value);
  }
  if (metricsInFlight) return metricsInFlight;

  metricsInFlight = collectMetrics()
    .then((value) => {
      metricsCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      metricsInFlight = null;
    });

  return metricsInFlight;
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

async function handleMetrics(response) {
  // A partial reading is still useful: the panel checks each field and shows
  // "unknown" for whatever the host did not provide.
  const metrics = await cachedMetrics();
  sendJson(response, 200, metrics);
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
    if (request.method === 'GET' && url.pathname === '/v1/metrics') {
      await handleMetrics(response);
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

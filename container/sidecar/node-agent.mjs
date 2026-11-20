/**
 * Narrow Docker control plane for the NCC admin panel.
 *
 * The sidecar is deliberately hardened and has no Docker access. This small
 * companion process runs with the sidecar image, mounts the Docker socket,
 * and exposes only five operations: read container state, read recent logs,
 * restart a named service, read host resource metrics, and pull the image of
 * a bundle service and recreate its container when the digest changed.
 * Container operations are limited to this Compose project.
 *
 * It is not a general Docker proxy. Every request names Compose services,
 * and the agent resolves them through the `com.docker.compose.project` label,
 * so a caller cannot address another project or an arbitrary container.
 * Image updates accept only the bundle's own service names, derive every
 * create option from the running container, and run the recreate in a
 * one-shot helper container so the agent can replace itself.
 *
 * Transport is host loopback plus a bearer token. The sidecar is the only
 * caller. `GET /health` is unauthenticated so Compose can probe the process.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { timingSafeEqual } from 'node:crypto';

const DOCKER_SOCKET = process.env.NCC_DOCKER_SOCKET || '/var/run/docker.sock';
// Path of the same socket on the host, used as the bind source when the
// one-shot recreate helper mounts it. Compose mounts it at the same path.
const HOST_DOCKER_SOCKET = process.env.NCC_UPDATE_DOCKER_SOCKET || '/var/run/docker.sock';
const PROJECT = process.env.NCC_COMPOSE_PROJECT || 'ncc-bundle';
const HOST = process.env.NCC_AGENT_HOST || '127.0.0.1';
const PORT = Number(process.env.NCC_AGENT_PORT || 3010);
const TOKEN = process.env.NCC_AGENT_TOKEN || '';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_LINES = 500;
const MAX_CONTAINERS = 50;
const METRICS_CACHE_MS = 5_000;
const DOCKER_USAGE_CACHE_MS = 60_000;
const IMAGE_DATE_CACHE_MS = 300_000;
const IMAGE_CHECK_CACHE_MS = 300_000;
const IMAGE_CHECK_ERROR_MS = 30_000;
const IMAGE_CHECK_TIMEOUT_MS = 8_000;
const IMAGE_CHECK_CONCURRENCY = 4;
const CPU_SAMPLE_MS = 200;
const PULL_TIMEOUT_MS = 15 * 60_000;
const HELPER_TIMEOUT_MS = 5 * 60_000;
const SERVICE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * The images this bundle ships. A caller cannot name an arbitrary image or
 * Compose service: updates are limited to this list, which is the set
 * `compose.yaml` defines. Custom services installed later keep using
 * `make service-install`.
 */
const UPDATEABLE_SERVICES = new Set([
  'caddy', 'ditto-web', 'node-agent', 'npanel', 'npack', 'opensearch',
  'relay', 'search', 'search-crawler', 'search-ui', 'sidecar', 'tor',
]);

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

function dockerRequest(path, { method = 'GET', body, headers = {}, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path,
        method,
        headers: { Host: 'docker', ...headers },
      },
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
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('Docker request timed out'));
    });
    request.on('error', reject);
    if (body !== undefined) request.end(body);
    else request.end();
  });
}

async function dockerJson(path, options = {}) {
  const response = await dockerRequest(path, options);
  if (response.status >= 400) {
    const detail = response.body.toString('utf8').slice(0, 300);
    throw new Error(`Docker returned HTTP ${response.status}: ${detail}`);
  }
  const text = response.body.toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Docker returned a non-JSON response');
  }
}

function postJson(path, payload) {
  return dockerJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
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

let imageInfoCache = { at: 0, byId: new Map() };

/** Image inspect data, cached for a few minutes; null when it was pruned. */
async function imageInfo(imageId) {
  if (!imageId) return null;
  if (Date.now() - imageInfoCache.at > IMAGE_DATE_CACHE_MS) {
    imageInfoCache = { at: Date.now(), byId: new Map() };
  }
  if (imageInfoCache.byId.has(imageId)) return imageInfoCache.byId.get(imageId);

  let info = null;
  try {
    info = await dockerJson(`/images/${encodeURIComponent(imageId)}/json`);
  } catch {
    // The image may have been pruned; the panel just shows no date.
  }
  imageInfoCache.byId.set(imageId, info);
  return info;
}

/** Creation time of an image ID, cached for a few minutes. */
async function imageCreatedAt(imageId) {
  const info = await imageInfo(imageId);
  return typeof info?.Created === 'string' ? info.Created : null;
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
      image: typeof entry.Image === 'string' ? entry.Image : null,
      imageId: typeof entry.ImageID === 'string' ? entry.ImageID : null,
      imageCreatedAt: null,
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
      // Config.Image is the tag the container was created from; Image is the
      // resolved image ID, which is what an update compares against.
      if (typeof detail?.Config?.Image === 'string') container.image = detail.Config.Image;
      if (typeof detail?.Image === 'string') container.imageId = detail.Image;
      container.imageCreatedAt = await imageCreatedAt(container.imageId);
    } catch {
      // The list view is enough when inspect fails; do not fail the request.
    }
  }));

  return containers;
}

// --- registry update checks -------------------------------------------------
//
// Docker can ask the registry for the digest of a tag without pulling it.
// `/distribution/<ref>/json` uses the daemon's own credentials and resolves
// multi-platform images the same way a pull would. Comparing that digest with
// the running image's RepoDigests tells the panel whether an Update would
// actually change anything; when the comparison is not possible the answer is
// null, never a guess.

const remoteDigestCache = new Map();

/** `registry/repo@sha256:…` or `sha256:…` -> `sha256:…`, else null. */
function digestOf(value) {
  if (typeof value !== 'string') return null;
  const at = value.indexOf('@');
  const raw = (at === -1 ? value : value.slice(at + 1)).trim();
  return /^sha(?:256:[a-f0-9]{64}|512:[a-f0-9]{128})$/i.test(raw) ? raw.toLowerCase() : null;
}

async function remoteDigest(ref, force) {
  const cached = remoteDigestCache.get(ref);
  const ttl = cached?.error ? IMAGE_CHECK_ERROR_MS : IMAGE_CHECK_CACHE_MS;
  if (!force && cached && Date.now() - cached.at < ttl) return cached;

  const entry = { at: Date.now(), digest: null, error: null };
  try {
    const info = await dockerJson(
      `/distribution/${encodeURIComponent(ref)}/json`,
      { timeoutMs: IMAGE_CHECK_TIMEOUT_MS },
    );
    entry.digest = digestOf(info?.Descriptor?.digest);
    if (!entry.digest) entry.error = 'The registry did not return a manifest digest';
  } catch (error) {
    entry.error = error instanceof Error ? error.message : 'The registry check failed';
  }
  remoteDigestCache.set(ref, entry);
  return entry;
}

async function imageRepoDigests(imageId) {
  const info = await imageInfo(imageId);
  return Array.isArray(info?.RepoDigests)
    ? info.RepoDigests.map(digestOf).filter(Boolean)
    : [];
}

/** One Compose service: the tag it runs, the digest the registry has, and
 * whether recreating it would change the image. */
async function serviceImageCheck(service, group, force) {
  const image = group.find((container) => typeof container.image === 'string')?.image;
  if (!image) return null;

  const remote = await remoteDigest(image, force);
  const local = new Set();
  for (const container of group) {
    for (const digest of await imageRepoDigests(container.imageId)) local.add(digest);
  }

  let updateAvailable = null;
  let checkError = remote.error;
  if (remote.digest && local.size) {
    updateAvailable = !local.has(remote.digest);
  } else if (!checkError && !local.size) {
    checkError = 'No local image digest is available for comparison';
  }

  return {
    service,
    image,
    remoteDigest: remote.digest,
    localDigests: [...local],
    updateAvailable,
    checkError,
    checkedAt: new Date().toISOString(),
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
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

/**
 * Whether each bundle image's tag has a different digest at the registry.
 * `refresh=1` bypasses the five-minute cache for the panel's Check images
 * button; a failed check is retried after thirty seconds.
 */
async function handleImages(request, response, url) {
  const force = url.searchParams.get('refresh') === '1';
  const containers = await projectContainers();
  const byService = new Map();
  for (const container of containers) {
    if (!container.image) continue;
    const group = byService.get(container.service) ?? [];
    group.push(container);
    byService.set(container.service, group);
  }

  const checks = await mapLimit(
    [...byService.entries()],
    IMAGE_CHECK_CONCURRENCY,
    ([service, group]) => serviceImageCheck(service, group, force),
  );
  sendJson(response, 200, {
    project: PROJECT,
    checks: checks.filter((check) => check !== null),
  });
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

// --- image updates --------------------------------------------------------
//
// The panel's Apps page lists the bundle's own images. Updating one means
// pulling the tag and, only when the digest changed, recreating the container
// with the options it already has. The recreate runs in a one-shot helper
// container built from this agent's image, because updating `node-agent`
// itself would otherwise stop the process halfway through.

let updateState = {
  inProgress: false,
  startedAt: null,
  finishedAt: null,
  error: null,
  services: [],
};
// The state above is set only after the container list is read. This guard
// closes the await window so two clicks cannot start two pulls.
let updateLock = false;

function updateSnapshot() {
  return {
    inProgress: updateState.inProgress,
    startedAt: updateState.startedAt,
    finishedAt: updateState.finishedAt,
    error: updateState.error,
    services: updateState.services.map((service) => ({ ...service })),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split image:tag or image@sha256:… without confusing a registry port. */
function splitImageRef(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  const at = ref.indexOf('@');
  if (at !== -1) {
    return { name: ref.slice(0, at), tag: null, digest: ref.slice(at + 1) };
  }
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > slash) return { name: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { name: ref, tag: 'latest' };
}

/**
 * Pull one image reference. Docker streams newline-delimited JSON progress;
 * this consumes it without buffering the whole stream and reports the first
 * error the daemon sent, which arrives with HTTP 200 in some cases.
 */
function pullImage(ref) {
  const parsed = splitImageRef(ref);
  if (!parsed || !parsed.name || !parsed.tag) {
    return Promise.reject(new Error(`Cannot pull ${ref}: it is pinned by digest`));
  }

  const query = new URLSearchParams({ fromImage: parsed.name, tag: parsed.tag });
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let failure = null;
    let timer = null;
    let request = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      request?.destroy();
      if (error) reject(error);
      else resolve();
    };

    request = http.request(
      { socketPath: DOCKER_SOCKET, path: `/images/create?${query}`, method: 'POST', headers: { Host: 'docker' } },
      (response) => {
        response.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          // Progress lines are small; keep only an unfinished tail.
          if (buffer.length > 256 * 1024) buffer = buffer.slice(-64 * 1024);
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            try {
              const message = JSON.parse(line);
              if (message?.error) {
                failure = message.errorDetail?.message || message.error;
              }
            } catch {
              // Non-JSON progress text is harmless.
            }
          }
        });
        response.on('end', () => {
          if (response.statusCode >= 400) {
            finish(new Error(`Docker returned HTTP ${response.statusCode} while pulling ${ref}`));
          } else if (failure) {
            finish(new Error(failure));
          } else {
            finish(null);
          }
        });
        response.on('error', (error) => finish(error));
      },
    );

    timer = setTimeout(
      () => finish(new Error(`Pulling ${ref} timed out`)),
      PULL_TIMEOUT_MS,
    );
    request.on('error', (error) => finish(error));
    request.end();
  });
}

/** The image this process runs from, used for the recreate helper. */
async function selfImageId() {
  try {
    const detail = await dockerJson(`/containers/${encodeURIComponent(os.hostname())}/json`);
    return typeof detail?.Image === 'string' ? detail.Image : null;
  } catch {
    return null;
  }
}

/** Remove exited helper containers left by an update that replaced this agent. */
async function cleanupUpdateHelpers() {
  try {
    const filters = encodeURIComponent(JSON.stringify({ label: ['org.ncc.update-helper'] }));
    const list = await dockerJson(`/containers/json?all=1&filters=${filters}`);
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry?.Id || entry.State === 'running') continue;
      await dockerJson(`/containers/${entry.Id}?force=1&v=0`, { method: 'DELETE' }).catch(() => {});
    }
  } catch {
    // Best effort: a leftover helper is harmless and the next start retries.
  }
}

/** Run recreate.mjs from the agent image and return its exit code and output. */
async function runRecreateHelper(plans, helperImage) {
  const name = `ncc-update-${Date.now().toString(36)}`;
  const created = await postJson(`/containers/create?name=${encodeURIComponent(name)}`, {
    Image: helperImage,
    Cmd: ['node', '/app/recreate.mjs'],
    // Clear any image entrypoint so the command above runs as written.
    Entrypoint: [],
    Env: [`NCC_RECREATE_PLAN=${Buffer.from(JSON.stringify({ services: plans })).toString('base64')}`],
    User: '0:0',
    WorkingDir: '/app',
    Labels: { 'org.ncc.update-helper': String(Date.now()) },
    HostConfig: {
      Binds: [`${HOST_DOCKER_SOCKET}:/var/run/docker.sock`],
      NetworkMode: 'none',
      AutoRemove: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16m' },
    },
  });

  const id = typeof created?.Id === 'string' ? created.Id : null;
  if (!id) throw new Error('Docker did not create the recreate helper');

  try {
    await dockerRequest(`/containers/${id}/start`, { method: 'POST' });
    const deadline = Date.now() + HELPER_TIMEOUT_MS;
    let state = null;
    while (Date.now() < deadline) {
      await sleep(1000);
      try {
        const info = await dockerJson(`/containers/${id}/json`);
        state = info?.State ?? null;
        if (state && state.Running !== true) break;
      } catch {
        // The container is gone; treat it as finished without an exit code.
        state = null;
        break;
      }
    }

    let logs = '';
    try {
      const response = await dockerRequest(`/containers/${id}/logs?stdout=1&stderr=1&tail=400`);
      logs = decodeDockerLogs(response.body).map((line) => line.message).join('\n');
    } catch {
      // Output is for diagnosis only.
    }

    return { code: Number.isInteger(state?.ExitCode) ? state.ExitCode : null, logs };
  } finally {
    await dockerJson(`/containers/${id}?force=1&v=0`, { method: 'DELETE' }).catch(() => {});
  }
}

/** The helper's machine-readable result line, if it finished. */
function recreateResults(logs) {
  const marker = 'NCC_RECREATE_RESULT ';
  const line = logs.split('\n').reverse().find((entry) => entry.startsWith(marker));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(marker.length));
    return Array.isArray(parsed?.services) ? parsed.services : null;
  } catch {
    return null;
  }
}

async function performUpdate(plans, helperImage) {
  const entries = new Map(updateState.services.map((entry) => [entry.service, entry]));
  let firstError = null;

  const pulled = new Map();
  for (const plan of plans) {
    const entry = entries.get(plan.service);
    const ref = plan.container.image;

    if (!ref) {
      entry.state = 'failed';
      entry.error = 'The container has no image reference';
      firstError ??= entry.error;
      continue;
    }
    if (!splitImageRef(ref)?.tag) {
      entry.state = 'pinned';
      entry.error = null;
      continue;
    }

    if (!pulled.has(ref)) {
      try {
        await pullImage(ref);
        // The tag's remote digest is what we just pulled; do not keep a
        // pre-pull answer around for the panel's next availability check.
        remoteDigestCache.delete(ref);
        const info = await dockerJson(`/images/${encodeURIComponent(ref)}/json`);
        pulled.set(ref, { imageId: typeof info?.Id === 'string' ? info.Id : null, error: null });
      } catch (error) {
        pulled.set(ref, { imageId: null, error: error instanceof Error ? error.message : 'pull failed' });
      }
    }

    const result = pulled.get(ref);
    if (result.error) {
      entry.state = 'failed';
      entry.error = result.error;
      firstError ??= result.error;
      continue;
    }

    entry.imageId = result.imageId ?? plan.container.imageId;
    entry.changed = Boolean(result.imageId && plan.container.imageId && result.imageId !== plan.container.imageId);
    entry.state = entry.changed ? 'queued' : 'current';
  }

  const queued = updateState.services.filter((entry) => entry.state === 'queued');
  if (queued.length) {
    for (const entry of queued) entry.state = 'recreating';

    try {
      const helperPlans = queued.map((entry) => ({
        service: entry.service,
        id: plans.find((plan) => plan.service === entry.service).container.id,
      }));
      const { code, logs } = await runRecreateHelper(helperPlans, helperImage);
      const results = recreateResults(logs);

      if (results) {
        for (const entry of queued) {
          const result = results.find((item) => item?.service === entry.service);
          if (result?.ok === true) {
            entry.state = 'recreated';
          } else {
            entry.state = 'failed';
            entry.error = typeof result?.error === 'string' ? result.error : 'The recreate helper failed';
            firstError ??= entry.error;
          }
        }
      } else {
        const detail = logs.trim().split('\n').filter(Boolean).slice(-1)[0] || null;
        for (const entry of queued) {
          entry.state = 'failed';
          entry.error = code === 0
            ? 'The recreate helper finished without a result'
            : (detail || `The recreate helper exited with code ${code ?? 'unknown'}`);
          firstError ??= entry.error;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The recreate helper failed';
      for (const entry of queued) {
        entry.state = 'failed';
        entry.error = message;
      }
      firstError ??= message;
    }
  }

  updateState.error = firstError;
}

async function handleUpdate(request, response) {
  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  const services = Array.isArray(body.services) ? body.services : null;
  const unique = services ? [...new Set(services)] : [];
  if (!unique.length || unique.length > UPDATEABLE_SERVICES.size
      || unique.some((service) => typeof service !== 'string'
        || !SERVICE_PATTERN.test(service)
        || !UPDATEABLE_SERVICES.has(service))) {
    sendJson(response, 400, {
      error: `services must name up to ${UPDATEABLE_SERVICES.size} bundle services (${[...UPDATEABLE_SERVICES].join(', ')})`,
    });
    return;
  }

  if (updateState.inProgress || updateLock) {
    sendJson(response, 409, { error: 'An image update is already in progress' });
    return;
  }
  updateLock = true;

  let containers;
  let helperImage;
  const plans = [];
  try {
    containers = await projectContainers();
    for (const service of unique) {
      const matches = containers.filter((container) => container.service === service);
      if (!matches.length) {
        updateLock = false;
        sendJson(response, 404, { error: `No container for: ${service}` });
        return;
      }
      if (matches.length > 1) {
        updateLock = false;
        sendJson(response, 409, { error: `Service ${service} has more than one container` });
        return;
      }
      plans.push({ service, container: matches[0] });
    }

    helperImage = containers.find((container) => container.service === 'node-agent')?.imageId
      || await selfImageId();
  } catch (error) {
    updateLock = false;
    sendJson(response, 503, {
      error: error instanceof Error ? error.message : 'Could not read the bundle containers',
    });
    return;
  }
  updateLock = false;

  if (!helperImage) {
    sendJson(response, 503, { error: 'Could not resolve the node-agent image for the recreate helper' });
    return;
  }

  updateState = {
    inProgress: true,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    services: plans.map((plan) => ({
      service: plan.service,
      image: plan.container.image,
      imageId: plan.container.imageId,
      state: 'queued',
      changed: null,
      error: null,
    })),
  };

  // Answer before the pull: a slow registry can take minutes, and recreating
  // sidecar or caddy would cut this response anyway.
  sendJson(response, 202, { accepted: true, status: updateSnapshot() });

  performUpdate(plans, helperImage)
    .catch((error) => {
      updateState.error = error instanceof Error ? error.message : 'The image update failed';
    })
    .finally(() => {
      updateState.inProgress = false;
      updateState.finishedAt = Date.now();
      const summary = updateState.services
        .map((entry) => `${entry.service}=${entry.state}`)
        .join(', ');
      if (updateState.error) {
        console.warn(`[node-agent] image update finished with errors: ${summary} (${updateState.error})`);
      } else {
        console.log(`[node-agent] image update finished: ${summary}`);
      }
    });
}

function handleUpdateStatus(response) {
  sendJson(response, 200, updateSnapshot());
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
    if (request.method === 'GET' && url.pathname === '/v1/images') {
      await handleImages(request, response, url);
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
    if (request.method === 'POST' && url.pathname === '/v1/update') {
      await handleUpdate(request, response);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/update/status') {
      handleUpdateStatus(response);
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(response, 503, { error: error instanceof Error ? error.message : 'Docker is unavailable' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[node-agent] listening on http://${HOST}:${PORT} for project ${PROJECT}`);
  cleanupUpdateHelpers();
});

/**
 * Pure helpers for the node-agent's Server Upgrade control plane.
 *
 * They live in their own module so the validation and shaping rules can be
 * tested without starting the HTTP server or touching Docker. The agent still
 * owns all file and Docker I/O.
 */

export const UPGRADE_TARGET_PATTERN = /^v?\d+\.\d+\.\d+$/;
export const UPGRADE_JOB_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;
export const UPGRADE_STATES = new Set(['running', 'success', 'failed']);
export const UPGRADE_STEP_IDS = ['prepare', 'checkout', 'pin', 'install', 'tor', 'release'];
export const UPGRADE_STEPS = [
  { id: 'prepare', label: 'Preparing the upgrade' },
  { id: 'checkout', label: 'Checking out the release' },
  { id: 'pin', label: 'Pinning bundle images' },
  { id: 'install', label: 'Pulling and recreating containers' },
  { id: 'tor', label: 'Reconciling Tor endpoints' },
  { id: 'release', label: 'Writing release information' },
];
const MAX_LOG_LINES = 20;
const MAX_LOG_LINE = 500;

function text(value, limit = 2000) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

/** `0.2.13`, `v0.2.13`, or null. */
export function normalizeUpgradeTarget(value) {
  if (typeof value !== 'string') return null;
  const target = value.trim();
  if (!UPGRADE_TARGET_PATTERN.test(target)) return null;
  return target.startsWith('v') ? target : `v${target}`;
}

/** The tag from an image reference, or null for a digest/latest lookup. */
export function imageTagFrom(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  if (ref.includes('@')) return null;
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon <= slash) return 'latest';
  return ref.slice(colon + 1);
}

/** A release file the sidecar can trust, or null when it is not shaped right. */
export function sanitizeRelease(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schema !== 1) return null;
  return {
    schema: 1,
    version: text(value.version, 64),
    tag: text(value.tag, 64),
    commit: text(value.commit, 128),
    origin: text(value.origin, 500),
    installedAt: text(value.installedAt, 64),
  };
}

/** The helper is usable only when its marker exists and the state dir is writable. */
export function helperFromMarker(value, writable) {
  const installed = Boolean(
    value
    && typeof value === 'object'
    && value.schema === 1
    && value.installed === true,
  );
  let error = null;
  if (!installed) error = 'The host upgrade helper is not installed';
  else if (!writable) error = 'The host upgrade state directory is not writable';
  return {
    available: installed && Boolean(writable),
    installed,
    installedAt: installed ? text(value.installedAt, 64) : null,
    error,
  };
}

/** Validate an upgrade request from the sidecar. */
export function buildUpgradeRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const jobId = typeof value.jobId === 'string' ? value.jobId.trim() : '';
  if (!UPGRADE_JOB_PATTERN.test(jobId)) return null;
  const target = normalizeUpgradeTarget(value.target);
  if (!target) return null;
  const requestedBy = typeof value.requestedBy === 'string'
    && /^[0-9a-f]{64}$/i.test(value.requestedBy)
    ? value.requestedBy.toLowerCase()
    : null;
  return { jobId, target, requestedBy };
}

/** Shape the root runner's status file for the panel. */
export function sanitizeUpgradeStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = UPGRADE_STATES.has(value.state) ? value.state : 'failed';
  const rawSteps = Array.isArray(value.steps)
    ? value.steps.filter((entry) => entry && typeof entry === 'object')
    : [];
  const steps = rawSteps.length
    ? rawSteps.slice(0, 12).map((entry) => ({
      id: text(entry.id, 64) ?? 'unknown',
      label: text(entry.label, 120) ?? 'Working',
    }))
    : UPGRADE_STEPS.map((entry) => ({ ...entry }));
  const total = Number.isInteger(value.totalSteps) && value.totalSteps > 0
    ? Math.min(value.totalSteps, steps.length)
    : steps.length;
  const index = Number.isInteger(value.stepIndex)
    && value.stepIndex >= 0
    && value.stepIndex <= total
    ? value.stepIndex
    : 0;
  const logTail = Array.isArray(value.logTail)
    ? value.logTail
      .slice(-MAX_LOG_LINES)
      .map((line) => text(line, MAX_LOG_LINE))
      .filter(Boolean)
    : [];
  const pins = value.pins && typeof value.pins === 'object' ? value.pins : {};
  const cleanPins = (entries) => (Array.isArray(entries) ? entries : [])
    .slice(0, 32)
    .map((entry) => text(entry, 64))
    .filter(Boolean);

  return {
    schema: 1,
    jobId: text(value.jobId, 128),
    state,
    step: text(value.step, 64),
    stepIndex: index,
    totalSteps: total,
    steps,
    target: text(value.target, 64),
    from: text(value.from, 64),
    startedAt: Number.isFinite(value.startedAt) ? value.startedAt : null,
    finishedAt: Number.isFinite(value.finishedAt) ? value.finishedAt : null,
    error: text(value.error),
    warning: text(value.warning),
    logTail,
    pins: {
      updated: cleanPins(pins.updated),
      skipped: cleanPins(pins.skipped),
    },
    dryRun: value.dryRun === true,
  };
}

/** A run is live while its status says so. */
export function upgradeIsRunning(status) {
  return Boolean(status && status.state === 'running');
}

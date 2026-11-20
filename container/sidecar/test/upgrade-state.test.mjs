import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUpgradeRequest,
  helperFromMarker,
  imageTagFrom,
  normalizeUpgradeTarget,
  sanitizeRelease,
  sanitizeUpgradeStatus,
  upgradeIsRunning,
} from '../upgrade-state.mjs';

test('upgrade target: normalises a bare version and keeps a v tag', () => {
  assert.equal(normalizeUpgradeTarget('0.2.13'), 'v0.2.13');
  assert.equal(normalizeUpgradeTarget('v0.2.13'), 'v0.2.13');
  assert.equal(normalizeUpgradeTarget('  v1.0.0  '), 'v1.0.0');
});

test('upgrade target: rejects branches, paths and shell text', () => {
  for (const value of [null, '', 'main', 'v0.2', 'v0.2.13; rm -rf /', '../../etc/passwd', 42]) {
    assert.equal(normalizeUpgradeTarget(value), null, String(value));
  }
});

test('upgrade request: requires a safe job id and a release target', () => {
  assert.deepEqual(
    buildUpgradeRequest({ jobId: 'abc12345', target: '0.2.13', requestedBy: 'A'.repeat(64) }),
    { jobId: 'abc12345', target: 'v0.2.13', requestedBy: 'a'.repeat(64) },
  );
  assert.equal(buildUpgradeRequest({ jobId: 'bad id', target: 'v0.2.13' }), null);
  assert.equal(buildUpgradeRequest({ jobId: 'abc12345', target: 'main' }), null);
  assert.equal(buildUpgradeRequest(null), null);
});

test('image tag: ignores digests and handles registry ports', () => {
  assert.equal(imageTagFrom('ghcr.io/imattau/ncc-server-sidecar:0.2.12'), '0.2.12');
  assert.equal(imageTagFrom('registry.example:5000/team/image:latest'), 'latest');
  assert.equal(imageTagFrom('registry.example:5000/team/image'), 'latest');
  assert.equal(imageTagFrom('ghcr.io/imattau/ncc-server-sidecar@sha256:abc'), null);
  assert.equal(imageTagFrom(null), null);
});

test('release: accepts the file shape and rejects other versions', () => {
  assert.deepEqual(
    sanitizeRelease({
      schema: 1,
      version: '0.2.12',
      tag: 'v0.2.12',
      commit: 'abc',
      origin: 'https://github.com/imattau/ncc-server',
      installedAt: '2026-11-20T10:00:00Z',
      extra: 'ignored',
    }),
    {
      schema: 1,
      version: '0.2.12',
      tag: 'v0.2.12',
      commit: 'abc',
      origin: 'https://github.com/imattau/ncc-server',
      installedAt: '2026-11-20T10:00:00Z',
    },
  );
  assert.equal(sanitizeRelease({ schema: 2, tag: 'v0.2.12' }), null);
  assert.equal(sanitizeRelease(null), null);
});

test('helper: needs the marker and a writable state directory', () => {
  assert.deepEqual(helperFromMarker({ schema: 1, installed: true, installedAt: 'now' }, true), {
    available: true,
    installed: true,
    installedAt: 'now',
    error: null,
  });
  assert.equal(helperFromMarker({ schema: 1, installed: true }, false).available, false);
  assert.equal(helperFromMarker({ schema: 1, installed: true }, false).error, 'The host upgrade state directory is not writable');
  assert.equal(helperFromMarker(null, true).error, 'The host upgrade helper is not installed');
});

test('status: shapes steps, counts and log tail', () => {
  const status = sanitizeUpgradeStatus({
    schema: 1,
    jobId: 'job-1',
    state: 'running',
    step: 'install',
    stepIndex: 4,
    totalSteps: 6,
    steps: [
      { id: 'prepare', label: 'Preparing' },
      { id: 'checkout', label: 'Checking out' },
      { id: 'pin', label: 'Pinning' },
      { id: 'install', label: 'Installing' },
      { id: 'tor', label: 'Tor' },
      { id: 'release', label: 'Release' },
    ],
    target: 'v0.2.13',
    from: 'v0.2.12',
    startedAt: 10,
    finishedAt: null,
    error: null,
    warning: null,
    logTail: ['one', 'two'],
    pins: { updated: ['SIDECAR_IMAGE'], skipped: ['RELAY_IMAGE'] },
  });

  assert.equal(status.state, 'running');
  assert.equal(status.stepIndex, 4);
  assert.equal(status.totalSteps, 6);
  assert.equal(status.steps.length, 6);
  assert.deepEqual(status.pins, { updated: ['SIDECAR_IMAGE'], skipped: ['RELAY_IMAGE'] });
  assert.deepEqual(status.logTail, ['one', 'two']);
  assert.equal(upgradeIsRunning(status), true);
});

test('status: missing or wrong fields do not invent progress', () => {
  assert.equal(sanitizeUpgradeStatus(null), null);
  const status = sanitizeUpgradeStatus({ state: 'failed', steps: [], stepIndex: 99, error: 'boom' });
  assert.equal(status.state, 'failed');
  assert.equal(status.stepIndex, 0);
  assert.equal(status.totalSteps, 6);
  assert.equal(status.steps.length, 6);
  assert.equal(status.error, 'boom');
  assert.equal(upgradeIsRunning(status), false);
});

test('status: log tail is capped', () => {
  const status = sanitizeUpgradeStatus({
    state: 'failed',
    logTail: Array.from({ length: 40 }, (_, index) => `line ${index}`),
  });
  assert.equal(status.logTail.length, 20);
  assert.equal(status.logTail[0], 'line 20');
  assert.equal(status.logTail[19], 'line 39');
});

import { describe, expect, it } from 'vitest';

import {
  cadenceProblem,
  readImageProgress,
  readNodeImages,
  readPanelPrunePlan,
  readPanelPruneResult,
  readResult,
  readServerUpgrade,
  readUpgradeJob,
  readUpgradeHelper,
  relayInputToUrl,
  resolvePanelApiBase,
  type PanelCadence,
} from './nccPanelApi';

const cadence = (overrides: Partial<PanelCadence> = {}): PanelCadence => ({
  refreshIntervalMinutes: 360,
  ncc02ExpiryDays: 14,
  ncc05TtlHours: 12,
  ...overrides,
});

describe('resolvePanelApiBase', () => {
  it('prefers the base the node published over the page origin', () => {
    expect(resolvePanelApiBase('https://node.example:8448/ncc-api'))
      .toBe('https://node.example:8448/ncc-api');
  });

  it('falls back to the page origin when no base is published', () => {
    const base = resolvePanelApiBase(null);
    expect(base).not.toBeNull();
    expect(base).toMatch(/^https?:\/\/.+\/ncc-api$/);
  });

  it('ignores an invalid published base', () => {
    const base = resolvePanelApiBase('not a url');
    expect(base).toMatch(/\/ncc-api$/);
  });
});

describe('relayInputToUrl', () => {
  it('keeps a complete wss URL and normalises the trailing slash', () => {
    expect(relayInputToUrl('wss://relay.example')).toBe('wss://relay.example/');
    expect(relayInputToUrl('wss://relay.example/path')).toBe('wss://relay.example/path/');
  });

  it('accepts a bare host and https URLs from the operator', () => {
    expect(relayInputToUrl('relay.example')).toBe('wss://relay.example/');
    expect(relayInputToUrl('https://relay.example')).toBe('wss://relay.example/');
    expect(relayInputToUrl('http://127.0.0.1:7777')).toBe('ws://127.0.0.1:7777/');
  });

  it('rejects values that are not websocket relays', () => {
    expect(relayInputToUrl('')).toBeNull();
    expect(relayInputToUrl('ftp://relay.example')).toBeNull();
    expect(relayInputToUrl('https://user:pass@relay.example')).toBeNull();
    expect(relayInputToUrl('not a url')).toBeNull();
  });
});

describe('cadenceProblem', () => {
  it('accepts values that keep records alive across a publish interval', () => {
    expect(cadenceProblem(cadence())).toBeNull();
    expect(cadenceProblem(cadence({ refreshIntervalMinutes: 60, ncc05TtlHours: 2 }))).toBeNull();
  });

  it('rejects out-of-range or non-integer values', () => {
    expect(cadenceProblem(cadence({ refreshIntervalMinutes: 0 }))).toContain('refreshIntervalMinutes');
    expect(cadenceProblem(cadence({ ncc02ExpiryDays: 366 }))).toContain('ncc02ExpiryDays');
    expect(cadenceProblem(cadence({ ncc05TtlHours: 1.5 }))).toContain('ncc05TtlHours');
  });

  it('rejects a TTL or expiry shorter than the publish interval', () => {
    expect(cadenceProblem(cadence({ refreshIntervalMinutes: 720, ncc05TtlHours: 12 })))
      .toContain('Locator TTL');
    expect(cadenceProblem(cadence({ refreshIntervalMinutes: 2880, ncc05TtlHours: 60, ncc02ExpiryDays: 2 })))
      .toContain('Service record expiry');
  });
});

describe('readResult npanel status', () => {
  const pubkey = 'a'.repeat(64);
  const admin = (extra: Record<string, unknown> = {}) => ({
    pubkey,
    npub: 'npub1example',
    status: 'active',
    createdAt: null,
    ...extra,
  });

  it('keeps npanel roles and a sync result', () => {
    const result = readResult({
      added: true,
      inviteSent: true,
      admins: [admin({ npanelRole: 'admin' })],
      npanel: { configured: true, synced: true, role: 'admin', error: null },
    });
    expect(result.added).toBe(true);
    expect(result.admins[0].npanelRole).toBe('admin');
    expect(result.npanel).toEqual({
      configured: true,
      available: undefined,
      synced: true,
      role: 'admin',
      error: null,
    });
  });

  it('distinguishes a key without npanel access from an unknown role', () => {
    const known = readResult({ admins: [admin({ npanelRole: null })] });
    expect(known.admins[0]).toHaveProperty('npanelRole', null);

    const unknown = readResult({ admins: [admin()] });
    expect(unknown.admins[0]).not.toHaveProperty('npanelRole');
  });

  it('reads the list-level npanel availability and ignores bad roles', () => {
    const result = readResult({
      admins: [admin({ npanelRole: 'owner' })],
      npanel: { configured: true, available: false, error: 'npanel is not reachable' },
    });
    expect(result.admins[0]).not.toHaveProperty('npanelRole');
    expect(result.npanel).toEqual({
      configured: true,
      available: false,
      synced: undefined,
      role: null,
      error: 'npanel is not reachable',
    });
  });

  it('omits npanel when an older sidecar did not report it', () => {
    expect(readResult({ admins: [] })).not.toHaveProperty('npanel');
  });
});

describe('readNodeImages', () => {
  const image = (extra: Record<string, unknown> = {}) => ({
    service: 'relay',
    label: 'Nostr relay',
    description: 'Stores events.',
    role: 'core',
    image: 'ghcr.io/imattau/ncc-server-relay:latest',
    tag: 'latest',
    imageId: 'sha256:abc',
    imageCreatedAt: '2026-01-01T00:00:00Z',
    state: 'running',
    health: null,
    containers: [{ name: 'ncc-bundle-relay-1', state: 'running', health: null }],
    updatable: true,
    remoteDigest: 'sha256:abc',
    updateAvailable: false,
    checkError: null,
    checkedAt: '2026-01-01T00:00:00Z',
    update: { state: 'current', changed: false, imageId: 'sha256:abc', error: null },
    ...extra,
  });

  it('reads images, their containers and the last update result', () => {
    const result = readNodeImages({
      agent: { available: true, error: null },
      updating: false,
      startedAt: 10,
      finishedAt: 20,
      error: null,
      images: [image(), image({ service: 'tor', role: 'infrastructure', update: null })],
    });

    expect(result.agent.available).toBe(true);
    expect(result.images).toHaveLength(2);
    expect(result.images[0].containers[0].name).toBe('ncc-bundle-relay-1');
    expect(result.images[0].update?.state).toBe('current');
    expect(result.images[0].updateAvailable).toBe(false);
    expect(result.images[0].checkedAt).toBe('2026-01-01T00:00:00Z');
    expect(result.images[1].role).toBe('infrastructure');
    expect(result.images[1].update).toBeNull();
  });

  it('keeps an unknown availability unknown and reports the registry error', () => {
    const result = readNodeImages({
      agent: { available: true, error: null },
      images: [image({
        update: null,
        remoteDigest: null,
        updateAvailable: null,
        checkError: 'Registry unreachable',
      })],
    });

    expect(result.images[0].updateAvailable).toBeNull();
    expect(result.images[0].remoteDigest).toBeNull();
    expect(result.images[0].checkError).toBe('Registry unreachable');

    const available = readNodeImages({
      agent: { available: true, error: null },
      images: [image({ update: null, updateAvailable: true, checkError: null })],
    });
    expect(available.images[0].updateAvailable).toBe(true);
  });

  it('defaults missing fields instead of inventing a version', () => {
    const result = readNodeImages({
      agent: {},
      images: [{
        service: 'search-ui',
        containers: 'nope',
        update: { state: 'failed', error: 'registry refused the pull' },
      }],
    });

    expect(result.agent.available).toBe(false);
    expect(result.images[0].label).toBe('search-ui');
    expect(result.images[0].image).toBeNull();
    expect(result.images[0].tag).toBeNull();
    expect(result.images[0].state).toBe('unknown');
    expect(result.images[0].containers).toEqual([]);
    expect(result.images[0].updatable).toBe(false);
    expect(result.images[0].update?.state).toBe('failed');
    expect(result.images[0].update?.error).toBe('registry refused the pull');
  });

  it('rejects a response without an image list', () => {
    expect(() => readNodeImages({ agent: { available: true } })).toThrow(/unexpected image list/);
  });
});


describe('readImageProgress', () => {
  it('counts terminal states and keeps the tracked service order', () => {
    const progress = readImageProgress({
      inProgress: true,
      startedAt: 10,
      finishedAt: null,
      error: null,
      total: 3,
      done: 2,
      percent: 67,
      services: [
        { service: 'relay', state: 'recreated', changed: true, error: null },
        { service: 'npanel', state: 'pulling', changed: false, error: null },
        { service: 'search', state: 'failed', changed: false, error: 'registry refused' },
      ],
    });

    expect(progress.inProgress).toBe(true);
    expect(progress.done).toBe(2);
    expect(progress.total).toBe(3);
    expect(progress.percent).toBe(67);
    expect(progress.services.map((entry) => entry.state)).toEqual(['recreated', 'pulling', 'failed']);
    expect(progress.services[2].error).toBe('registry refused');
  });

  it('defaults a missing total and percent from the service list', () => {
    const progress = readImageProgress({
      inProgress: false,
      services: [{ service: 'relay', state: 'unknown' }],
    });

    expect(progress.total).toBe(1);
    expect(progress.done).toBe(0);
    expect(progress.percent).toBe(0);
    expect(progress.services[0]).toEqual({
      service: 'relay', state: 'unknown', changed: false, imageId: null, error: null,
    });
  });
});

describe('readPanelPrunePlan', () => {
  it('reads candidates, sizes and the previous-release copy', () => {
    const plan = readPanelPrunePlan({
      keepPrevious: true,
      count: 2,
      estimateBytes: 3072,
      repositories: ['ghcr.io/imattau/ncc-server-search'],
      images: [
        {
          ref: 'ghcr.io/imattau/ncc-server-search:0.2.14',
          refs: ['ghcr.io/imattau/ncc-server-search:0.2.14'],
          imageId: 'sha256:old',
          sizeBytes: 1024,
          createdAt: '2026-11-01T00:00:00.000Z',
        },
        { ref: 'ghcr.io/imattau/ncc-server-search:0.2.15', imageId: 'sha256:previous' },
      ],
      kept: [{
        ref: 'ghcr.io/imattau/ncc-server-relay:0.2.15',
        refs: ['ghcr.io/imattau/ncc-server-relay:0.2.15'],
        imageId: 'sha256:relay',
        sizeBytes: 2048,
        createdAt: null,
        reason: 'previous-release',
      }],
    });

    expect(plan.keepPrevious).toBe(true);
    expect(plan.count).toBe(2);
    expect(plan.estimateBytes).toBe(3072);
    expect(plan.images[0].createdAt).toBe('2026-11-01T00:00:00.000Z');
    expect(plan.images[1].sizeBytes).toBeNull();
    expect(plan.kept[0].reason).toBe('previous-release');
  });

  it('keeps a missing keepPrevious or size unknown instead of inventing one', () => {
    const plan = readPanelPrunePlan({ images: [] });

    expect(plan.keepPrevious).toBe(true);
    expect(plan.count).toBe(0);
    expect(plan.estimateBytes).toBeNull();
    expect(plan.images).toEqual([]);
    expect(plan.kept).toEqual([]);
  });

  it('ignores entries that name no image and rejects a non-object', () => {
    const plan = readPanelPrunePlan({
      images: [null, { imageId: 'sha256:orphan' }, { ref: 'x:1', refs: 'nope' }],
    });
    expect(plan.count).toBe(1);
    expect(plan.images.map((image) => image.ref)).toEqual(['x:1']);
    expect(plan.images[0].refs).toEqual([]);

    expect(() => readPanelPrunePlan(null)).toThrow(/unexpected image clean-up plan/);
  });
});

describe('readPanelPruneResult', () => {
  it('reads removed tags, failures and the freed byte count', () => {
    const result = readPanelPruneResult({
      keepPrevious: false,
      removed: [{ ref: 'ghcr.io/imattau/ncc-server-search:0.2.14', imageId: 'sha256:old' }],
      failed: [{ ref: 'ghcr.io/imattau/ncc-server-relay:0.2.15', error: 'in use' }],
      freedBytes: 4096,
    });

    expect(result.keepPrevious).toBe(false);
    expect(result.removed.map((image) => image.ref)).toEqual([
      'ghcr.io/imattau/ncc-server-search:0.2.14',
    ]);
    expect(result.failed).toEqual([{
      ref: 'ghcr.io/imattau/ncc-server-relay:0.2.15', error: 'in use',
    }]);
    expect(result.freedBytes).toBe(4096);
  });

  it('keeps an unmeasured freed total and a failed delete honest', () => {
    const result = readPanelPruneResult({
      removed: [],
      failed: [{ ref: 'x:1' }],
    });

    expect(result.freedBytes).toBeNull();
    expect(result.failed[0].error).toBe('The delete failed');
    expect(() => readPanelPruneResult(null)).toThrow(/unexpected image clean-up result/);
  });
});

describe('readServerUpgrade', () => {
  it('reads availability, helper state and the current release', () => {
    const upgrade = readServerUpgrade({
      current: { version: '0.2.12', tag: 'v0.2.12', commit: 'abc', source: 'host' },
      latest: { tag: 'v0.2.13', version: '0.2.13', url: 'https://example/release', publishedAt: '2026-11-20T00:00:00Z' },
      upgradeAvailable: true,
      reason: null,
      helper: { available: true, installed: true, installedAt: '2026-11-19T00:00:00Z', error: null },
      job: null,
      progressToken: null,
      checkedAt: 10,
      error: null,
    });

    expect(upgrade.upgradeAvailable).toBe(true);
    expect(upgrade.current?.tag).toBe('v0.2.12');
    expect(upgrade.latest?.tag).toBe('v0.2.13');
    expect(upgrade.helper.available).toBe(true);
    expect(upgrade.job).toBeNull();
  });

  it('keeps an unknown availability unknown instead of guessing', () => {
    const upgrade = readServerUpgrade({
      current: null,
      latest: null,
      upgradeAvailable: null,
      reason: 'The GitHub release check timed out',
      helper: {},
      job: null,
    });

    expect(upgrade.upgradeAvailable).toBeNull();
    expect(upgrade.reason).toBe('The GitHub release check timed out');
    expect(upgrade.helper.available).toBe(false);
    expect(upgrade.helper.error).toBeNull();
  });

  it('rejects a response that is not an object', () => {
    expect(() => readServerUpgrade(null)).toThrow(/unexpected upgrade/);
  });
});

describe('readUpgradeJob', () => {
  it('reads steps, progress and pins', () => {
    const job = readUpgradeJob({
      jobId: 'job-1',
      state: 'running',
      step: 'install',
      stepIndex: 4,
      totalSteps: 6,
      steps: [
        { id: 'prepare', label: 'Preparing' },
        { id: 'install', label: 'Installing' },
      ],
      target: 'v0.2.13',
      from: 'v0.2.12',
      startedAt: 10,
      finishedAt: null,
      error: null,
      warning: 'Tor reconcile exited with code 1',
      logTail: ['line'],
      pins: { updated: ['SIDECAR_IMAGE'], skipped: ['RELAY_IMAGE'] },
      dryRun: false,
    });

    expect(job?.state).toBe('running');
    expect(job?.stepIndex).toBe(4);
    expect(job?.totalSteps).toBe(6);
    expect(job?.warning).toContain('Tor reconcile');
    expect(job?.pins.updated).toEqual(['SIDECAR_IMAGE']);
  });

  it('rejects an unknown state and clamps a bad index', () => {
    expect(readUpgradeJob({ state: 'sideways' })).toBeNull();
    const job = readUpgradeJob({ state: 'failed', stepIndex: 99, totalSteps: 3 });
    expect(job?.stepIndex).toBe(3);
    expect(job?.steps).toEqual([]);
  });
});

describe('readUpgradeHelper', () => {
  it('reports an unavailable helper with its reason', () => {
    expect(readUpgradeHelper({ available: false, installed: false, error: 'not installed' })).toEqual({
      available: false,
      installed: false,
      installedAt: null,
      error: 'not installed',
    });
    expect(readUpgradeHelper(null).error).toBe('The host upgrade helper is not available');
  });
});

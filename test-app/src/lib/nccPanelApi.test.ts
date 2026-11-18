import { describe, expect, it } from 'vitest';

import {
  cadenceProblem,
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

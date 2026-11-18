import { describe, expect, it } from 'vitest';

import { cadenceProblem, relayInputToUrl, type PanelCadence } from './nccPanelApi';

const cadence = (overrides: Partial<PanelCadence> = {}): PanelCadence => ({
  refreshIntervalMinutes: 360,
  ncc02ExpiryDays: 14,
  ncc05TtlHours: 12,
  ...overrides,
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

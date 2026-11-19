import { describe, expect, it } from 'vitest';

import { readMetrics } from './nccPanelApi';

const sample = {
  available: true,
  error: null,
  metrics: {
    collectedAt: 1_700_000_000,
    host: {
      hostname: 'node',
      kernel: '6.8.0',
      os: 'Ubuntu 24.04',
      dockerVersion: '27.3.1',
      uptimeSeconds: 86_400,
    },
    cpu: { cores: 8, load1: 0.4, load5: 0.6, load15: 0.8, usagePercent: 12.5 },
    memory: { totalBytes: 16_000, availableBytes: 6_000, usedBytes: 10_000, usedPercent: 62.5 },
    storage: { totalBytes: 100_000, freeBytes: 25_000, usedBytes: 75_000, usedPercent: 75 },
    docker: {
      imagesBytes: 1_000,
      containersBytes: 200,
      volumesBytes: 300,
      buildCacheBytes: 400,
      totalBytes: 1_900,
      images: 12,
      containers: 7,
      volumes: 3,
    },
  },
};

describe('readMetrics', () => {
  it('keeps a complete payload', () => {
    const metrics = readMetrics(sample);
    expect(metrics.available).toBe(true);
    expect(metrics.error).toBeNull();
    expect(metrics.collectedAt).toBe(1_700_000_000);
    expect(metrics.host.hostname).toBe('node');
    expect(metrics.cpu?.cores).toBe(8);
    expect(metrics.cpu?.usagePercent).toBe(12.5);
    expect(metrics.memory?.usedBytes).toBe(10_000);
    expect(metrics.storage?.freeBytes).toBe(25_000);
    expect(metrics.docker?.images).toBe(12);
  });

  it('reports an unavailable node without inventing values', () => {
    const metrics = readMetrics({ available: false, error: 'agent not running', metrics: null });
    expect(metrics.available).toBe(false);
    expect(metrics.error).toBe('agent not running');
    expect(metrics.collectedAt).toBeNull();
    expect(metrics.cpu).toBeNull();
    expect(metrics.memory).toBeNull();
    expect(metrics.storage).toBeNull();
    expect(metrics.docker).toBeNull();
    expect(metrics.host.hostname).toBeNull();
  });

  it('rejects out-of-range percentages, negative sizes and zero cores', () => {
    const metrics = readMetrics({
      available: true,
      metrics: {
        cpu: { cores: 0, usagePercent: 140 },
        memory: { totalBytes: -1, usedPercent: -3 },
        storage: { usedPercent: 250 },
      },
    });
    expect(metrics.cpu?.cores).toBeNull();
    expect(metrics.cpu?.usagePercent).toBeNull();
    expect(metrics.memory?.totalBytes).toBeNull();
    expect(metrics.memory?.usedPercent).toBeNull();
    expect(metrics.storage?.usedPercent).toBeNull();
  });

  it('handles a missing metrics object and an unexpected root', () => {
    const metrics = readMetrics({ available: true, metrics: null });
    expect(metrics.cpu).toBeNull();
    expect(metrics.host.hostname).toBeNull();
    expect(() => readMetrics('nope')).toThrow(/unexpected metrics response/);
  });
});

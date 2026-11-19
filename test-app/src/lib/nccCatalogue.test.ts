import { describe, expect, it } from 'vitest';

import {
  readCatalogue,
  readCatalogueEntry,
  readCatalogueService,
} from './nccPanelApi';

const publisher = 'a'.repeat(64);
const releaseId = 'b'.repeat(64);

const entry = {
  releaseEventId: releaseId,
  publisher,
  npub: 'npub1example',
  name: 'hello',
  version: '1.0.0',
  kind: 'ncc-service',
  sha256: 'c'.repeat(64),
  publishedAt: 1_700_000_000,
  compatible: true,
  official: true,
  trusted: true,
  summary: 'Hello',
  categories: ['Social'],
  releaseNotes: null,
  supportUrl: null,
  downloadSize: 1024,
  installedSize: 2048,
  releaseDate: '2026-01-01',
  icon: { url: 'https://example.com/icon.png', sha256: 'd'.repeat(64) },
  details: { repo: null, commit: null, depends: [], requires: [], postInstall: [] },
};

describe('readCatalogueEntry', () => {
  it('keeps the fields the catalogue needs', () => {
    const parsed = readCatalogueEntry(entry);
    expect(parsed?.name).toBe('hello');
    expect(parsed?.official).toBe(true);
    expect(parsed?.categories).toEqual(['Social']);
    expect(parsed?.icon?.sha256).toBe('d'.repeat(64));
  });

  it('drops a malformed release instead of rendering it', () => {
    expect(readCatalogueEntry({ ...entry, releaseEventId: undefined })).toBeNull();
    expect(readCatalogueEntry({ ...entry, publisher: '' })).toBeNull();
    expect(readCatalogueEntry('not an object')).toBeNull();
  });
});

describe('readCatalogue', () => {
  it('reads status, trust and entries', () => {
    const catalogue = readCatalogue({
      available: true,
      error: null,
      refreshing: true,
      refreshError: 'relay query timed out',
      official: { publisher, npub: 'npub1official' },
      trusted: [{ publisher, npub: 'npub1official', official: true }],
      status: { present: true, ageSeconds: 12, stale: false, staleAfterSeconds: 21600, releases: 1 },
      entries: [entry, { name: 'broken' }],
    });

    expect(catalogue.available).toBe(true);
    expect(catalogue.refreshing).toBe(true);
    expect(catalogue.refreshError).toBe('relay query timed out');
    expect(catalogue.official?.publisher).toBe(publisher);
    expect(catalogue.trusted).toHaveLength(1);
    expect(catalogue.status?.ageSeconds).toBe(12);
    expect(catalogue.entries).toHaveLength(1);
  });

  it('reports an unavailable catalogue without inventing entries', () => {
    const catalogue = readCatalogue({ available: false, error: 'not running' });
    expect(catalogue.available).toBe(false);
    expect(catalogue.error).toBe('not running');
    expect(catalogue.refreshing).toBe(false);
    expect(catalogue.refreshError).toBeNull();
    expect(catalogue.entries).toEqual([]);
  });
});

describe('readCatalogueService', () => {
  it('reads the verified descriptor and provenance', () => {
    const service = readCatalogueService({
      provenance: {
        publisher,
        npub: 'npub1example',
        name: 'hello',
        version: '1.0.0',
        releaseEventId: releaseId,
        artifactEventId: 'e'.repeat(64),
        sha256: 'c'.repeat(64),
        os: 'linux',
        arch: 'x86_64',
        verified: true,
      },
      descriptor: {
        service_id: 'hello',
        name: 'Hello',
        image: `ghcr.io/acme/hello@sha256:${'f'.repeat(64)}`,
        public_port: 8450,
        backend_port: 18080,
        container_port: 80,
        probe_path: '/',
        volumes: { data: '/data' },
        env: { LOG_LEVEL: 'info' },
      },
      readme: 'Hello.',
      artifact: { sha256: 'c'.repeat(64), size: 100, url: 'https://example.com/a.npk', urls: [] },
      warnings: [],
    });

    expect(service.provenance.verified).toBe(true);
    expect(service.descriptor.serviceId).toBe('hello');
    expect(service.descriptor.volumes).toEqual([{ name: 'data', path: '/data' }]);
    expect(service.descriptor.envKeys).toEqual(['LOG_LEVEL']);
    expect(service.artifact.size).toBe(100);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNpackRelease, resolveNpackArtifact, toSearchRow } from '../src/adapters/npack.js';

function releaseEvent(overrides = {}) {
  return {
    pubkey: 'a'.repeat(64),
    id: 'release-id',
    created_at: 1_700_000_000,
    tags: [
      ['d', 'ncc-browser/1.2.0/x86_64'],
      ['v', '1'],
      ['name', 'ncc-browser'],
      ['version', '1.2.0'],
      ['os', 'linux'],
      ['arch', 'x86_64'],
      ['format', 'npk'],
      ['x', 'b'.repeat(64)],
      ['artifact', 'artifact-id'],
      ['summary', 'The ncc:// browser'],
      ['homepage', 'https://example.com'],
      ['category', 'browser'],
      ['category', 'nostr'],
    ],
    ...overrides,
  };
}

test('resolveNpackRelease extracts the required and store-listing tags', () => {
  const resolved = resolveNpackRelease(releaseEvent());
  assert.equal(resolved.itemId, 'ncc-browser/1.2.0/x86_64');
  assert.equal(resolved.kind, 'npack');
  assert.equal(resolved.name, 'ncc-browser');
  assert.equal(resolved.version, '1.2.0');
  assert.equal(resolved.title, 'ncc-browser 1.2.0 (linux/x86_64)');
  assert.equal(resolved.description, 'The ncc:// browser');
  assert.equal(resolved.artifactId, 'artifact-id');
  assert.equal(resolved.sha256, 'b'.repeat(64));
  assert.equal(resolved.postedAt, 1_700_000_000);
  assert.deepEqual(resolved.hashtags, ['browser', 'nostr']);
});

test('resolveNpackRelease omits the platform suffix when os/arch are "any"', () => {
  const resolved = resolveNpackRelease(
    releaseEvent({ tags: releaseEvent().tags.map((t) => (t[0] === 'os' || t[0] === 'arch' ? [t[0], 'any'] : t)) }),
  );
  assert.equal(resolved.title, 'ncc-browser 1.2.0');
});

test('resolveNpackRelease returns null when a required tag is missing', () => {
  assert.equal(resolveNpackRelease(releaseEvent({ tags: [['name', 'x']] })), null);
});

test('resolveNpackRelease returns null for a malformed sha256', () => {
  const tags = releaseEvent().tags.map((t) => (t[0] === 'x' ? ['x', 'not-hex'] : t));
  assert.equal(resolveNpackRelease(releaseEvent({ tags })), null);
});

test('resolveNpackArtifact extracts the download url and MIME type', () => {
  const resolved = resolveNpackArtifact({
    id: 'artifact-id',
    tags: [['url', 'https://blossom.example.com/abc.npk'], ['m', 'application/octet-stream']],
  });
  assert.deepEqual(resolved, { id: 'artifact-id', url: 'https://blossom.example.com/abc.npk', mediaType: 'application/octet-stream' });
});

test('resolveNpackArtifact returns null with no url tag', () => {
  assert.equal(resolveNpackArtifact({ id: 'x', tags: [] }), null);
});

test('toSearchRow joins a release with its artifact once resolved', () => {
  const release = resolveNpackRelease(releaseEvent());
  const withoutArtifact = toSearchRow(release, null);
  assert.equal(withoutArtifact.mediaUrl, null);
  assert.equal(withoutArtifact.postedAt, 1_700_000_000, 'the release date survives until the artifact arrives');

  const artifact = resolveNpackArtifact({
    id: 'artifact-id',
    tags: [['url', 'https://blossom.example.com/abc.npk'], ['m', 'application/octet-stream']],
  });
  const withArtifact = toSearchRow(release, artifact);
  assert.equal(withArtifact.mediaUrl, 'https://blossom.example.com/abc.npk');
  assert.equal(withArtifact.mediaType, 'application/octet-stream');
});

// Verifies src/fetcher.js's spkiFingerprint() against the REAL sidecar
// reference implementation, not a hand-rolled re-derivation of it: the
// expected `k` here comes from `computeKFromCertPem` in `ncc-06-js`, the
// exact package ncc-06/ncc-sidecar depends on to compute the `k` it
// publishes in NCC-02/NCC-05 records (pinned sidecar commit 186c3ad,
// ncc-06-js/src/k.js).
//
// This is the regression test for the bug caught during scaffolding: the
// fingerprint's *input bytes* were already correct, but its *encoding* used
// padded base64 instead of the sidecar's unpadded base64url, which would
// have made every TLS endpoint spuriously fail `k` pin verification.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { computeKFromCertPem } from 'ncc-06-js';
import { fetchResolvedEndpoint } from '../src/fetcher.js';

let hasOpenssl = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  hasOpenssl = false;
}

let server;
let port;
let certPem;
let expectedK;
let tmpDir;

before(async () => {
  if (!hasOpenssl) return;

  tmpDir = mkdtempSync(join(tmpdir(), 'ncc-search-k-test-'));
  const keyPath = join(tmpDir, 'key.pem');
  const certPath = join(tmpDir, 'cert.pem');

  // A self-signed cert, same shape a real NCC-02/NCC-05 publisher would use
  // for a TLS-protected endpoint (see docs/schema-verification.md: the
  // sidecar's `ensureSelfSignedCert`).
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=ncc-search-test',
  ], { stdio: 'ignore' });

  certPem = readFileSync(certPath, 'utf8');
  const keyPem = readFileSync(keyPath, 'utf8');

  // The value a real sidecar would compute and publish as `k`.
  expectedK = computeKFromCertPem(certPem);

  server = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ncc-search k-fingerprint test endpoint');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test('fetcher observes the same k the sidecar would publish', { skip: !hasOpenssl && 'openssl not available' }, async () => {
  const page = await fetchResolvedEndpoint(`https://127.0.0.1:${port}/`, {
    expectedFingerprint: expectedK,
  });

  assert.equal(page.statusCode, 200);
  assert.equal(page.observedFingerprint, expectedK);
});

test('fetcher fails closed on a genuine k mismatch', { skip: !hasOpenssl && 'openssl not available' }, async () => {
  await assert.rejects(
    () =>
      fetchResolvedEndpoint(`https://127.0.0.1:${port}/`, {
        expectedFingerprint: 'deliberately-wrong-fingerprint',
      }),
    /k-mismatch/,
  );
});

test('expected k is unpadded base64url, matching the sidecar encoding', { skip: !hasOpenssl && 'openssl not available' }, () => {
  assert.doesNotMatch(expectedK, /[+/=]/, 'k must not contain standard-base64 characters');
});

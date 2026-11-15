import { mkdirSync, readFileSync, writeFileSync, chmodSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = resolve(appDir, '..');
const secretDir = resolve(appDir, '.secrets');
const identityPath = resolve(secretDir, 'ncc-test-key.json');
const sharedIdentityPath = resolve(projectDir, '.secrets/operator-identity.json');
const envPath = resolve(appDir, '.env.local');

mkdirSync(secretDir, { recursive: true, mode: 0o700 });
chmodSync(secretDir, 0o700);

let identity;
if (existsSync(sharedIdentityPath)) {
  const shared = JSON.parse(readFileSync(sharedIdentityPath, 'utf8'));
  const decoded = nip19.decode(shared.nsec);
  if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array)) {
    throw new Error('Shared operator identity contains an invalid nsec.');
  }
  const expectedNpub = nip19.npubEncode(getPublicKey(decoded.data));
  if (shared.npub !== expectedNpub) throw new Error('Shared operator identity npub does not match its nsec.');
  identity = { nsec: shared.nsec, npub: expectedNpub };
  if (existsSync(identityPath)) {
    const previous = JSON.parse(readFileSync(identityPath, 'utf8'));
    if (previous.nsec !== identity.nsec) {
      const backupPath = resolve(secretDir, `ncc-test-key.previous-${new Date().toISOString().replaceAll(':', '-')}.json`);
      copyFileSync(identityPath, backupPath);
      chmodSync(backupPath, 0o600);
    }
  }
  writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
} else try {
  identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  if (typeof identity.nsec !== 'string') throw new Error('Existing identity has no nsec.');

  const decoded = nip19.decode(identity.nsec);
  if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array)) {
    throw new Error('Existing identity contains an invalid nsec.');
  }

  const expectedNpub = nip19.npubEncode(getPublicKey(decoded.data));
  if (identity.npub !== expectedNpub) throw new Error('Existing npub does not match its nsec.');
  identity = { nsec: identity.nsec, npub: expectedNpub };
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    const secretKey = generateSecretKey();
    identity = {
      nsec: nip19.nsecEncode(secretKey),
      npub: nip19.npubEncode(getPublicKey(secretKey)),
    };
    writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } else {
    throw error;
  }
}

chmodSync(identityPath, 0o600);

let envContent = '';
try {
  envContent = readFileSync(envPath, 'utf8');
} catch (error) {
  if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
}

const preservedLines = envContent.split(/\r?\n/).filter((line) => !line.startsWith('VITE_NCC_TEST_NPUB='));
while (preservedLines.length > 0 && preservedLines.at(-1) === '') preservedLines.pop();
preservedLines.push(`VITE_NCC_TEST_NPUB=${identity.npub}`);
writeFileSync(envPath, `${preservedLines.join('\n')}\n`, { mode: 0o600 });
chmodSync(envPath, 0o600);

console.log(`Test identity ready: ${identity.npub}`);
console.log(`Private key stored in ${identityPath} (mode 0600; Git-ignored).`);

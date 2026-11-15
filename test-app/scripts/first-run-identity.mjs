import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const secretDir = resolve(repo, '.secrets');
const identityPath = resolve(secretDir, 'operator-identity.json');
const testIdentityPath = resolve(repo, 'test-app/.secrets/ncc-test-key.json');
const testEnvPath = resolve(repo, 'test-app/.env.local');
const remoteHelper = resolve(repo, 'scripts/apply-shared-identity.py');
const yes = process.argv.includes('--yes');

function checkedIdentity(raw) {
  const decoded = nip19.decode(raw.nsec);
  if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array)) {
    throw new Error('Identity file contains an invalid nsec. It was left unchanged.');
  }
  const pubkey = getPublicKey(decoded.data);
  const npub = nip19.npubEncode(pubkey);
  if (raw.npub !== npub || (raw.pubkey && raw.pubkey !== pubkey)) {
    throw new Error('Identity file keys do not match. It was left unchanged.');
  }
  return { format: 1, nsec: raw.nsec, npub, pubkey };
}

mkdirSync(secretDir, { recursive: true, mode: 0o700 });
chmodSync(secretDir, 0o700);
let identity;
if (existsSync(identityPath)) {
  identity = checkedIdentity(JSON.parse(readFileSync(identityPath, 'utf8')));
} else {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  identity = {
    format: 1,
    nsec: nip19.nsecEncode(secret),
    npub: nip19.npubEncode(pubkey),
    pubkey,
  };
  writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
chmodSync(identityPath, 0o600);

const io = createInterface({ input: stdin, output: stdout });
async function prompt(question) { return (await io.question(question)).trim(); }

let target;
let remoteProject;
try {
  target = process.env.NCC_SSH_TARGET || await prompt('SSH target for the Compose VM (user@host): ');
  if (!target || /\s/.test(target)) throw new Error('Set NCC_SSH_TARGET to one SSH destination (user@host).');
  remoteProject = process.env.NCC_REMOTE_PROJECT_DIR || await prompt('Remote checkout directory [/opt/ncc-server]: ') || '/opt/ncc-server';
  console.log(`Identity: ${identity.npub}`);
  console.log('This applies the identity to the VM sidecar, active service records, Ditto Relay, and Npanel admin.');
  console.log('The VM migration replaces sidecar admin/service signer keys and republishes active locators.');
  if (!yes && await prompt('Type "migrate" to continue: ') !== 'migrate') {
    console.log('No VM changes made. The local identity is saved for reuse.');
    process.exit(0);
  }
} finally {
  io.close();
}

const remoteFile = `/tmp/ncc-apply-shared-identity-${process.pid}.py`;
const remoteIdentity = `.ncc-identity-${process.pid}.json`;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit status ${result.status}`);
}

try {
  run('scp', ['-q', remoteHelper, `${target}:${remoteFile}`]);
  run('scp', ['-q', identityPath, `${target}:${remoteIdentity}`]);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const privilege = target.split('@', 1)[0] === 'root' ? '' : 'sudo ';
  const remoteCommand = `chmod 600 "$HOME/${remoteIdentity}" && ${privilege}python3 ${quote(remoteFile)} --project-dir ${quote(remoteProject)} --identity-file "$HOME/${remoteIdentity}"`;
  run('ssh', ['-t', target, remoteCommand]);
} catch (error) {
  console.error(`Could not apply the identity to ${target}: ${error.message}`);
  console.error(`The VM was not migrated. The key remains saved locally at ${identityPath}.`);
  process.exitCode = 1;
} finally {
  spawnSync('ssh', [target, `rm -f '${remoteFile}' "$HOME/${remoteIdentity}"`], { stdio: 'ignore' });
}
if (process.exitCode) process.exit(process.exitCode);

// Keep the test publisher on the same operator identity. Preserve its prior
// keypair before replacing it, since it may have published a fixture before.
mkdirSync(dirname(testIdentityPath), { recursive: true, mode: 0o700 });
chmodSync(dirname(testIdentityPath), 0o700);
if (existsSync(testIdentityPath)
    && JSON.parse(readFileSync(testIdentityPath, 'utf8')).nsec !== identity.nsec) {
  const previous = resolve(dirname(testIdentityPath), `ncc-test-key.previous-${new Date().toISOString().replaceAll(':', '-')}.json`);
  copyFileSync(testIdentityPath, previous);
  chmodSync(previous, 0o600);
}
writeFileSync(testIdentityPath, `${JSON.stringify({ nsec: identity.nsec, npub: identity.npub }, null, 2)}\n`, { mode: 0o600 });
chmodSync(testIdentityPath, 0o600);
let env = existsSync(testEnvPath) ? readFileSync(testEnvPath, 'utf8') : '';
const lines = env.split(/\r?\n/).filter((line) => !line.startsWith('VITE_NCC_TEST_NPUB='));
while (lines.length && lines.at(-1) === '') lines.pop();
lines.push(`VITE_NCC_TEST_NPUB=${identity.npub}`);
writeFileSync(testEnvPath, `${lines.join('\n')}\n`, { mode: 0o600 });
chmodSync(testEnvPath, 0o600);

console.log(`Local keypair saved at ${identityPath} (Git-ignored, mode 0600).`);
console.log(`Test app publisher now uses ${identity.npub}; rebuild it before deployment if needed.`);

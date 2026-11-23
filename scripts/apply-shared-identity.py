#!/usr/bin/env python3
"""Apply an operator-owned Nostr identity to an NCC Compose deployment.

The identity is read from stdin so the nsec is never part of argv or a log.
It is used by both the Compose first-start bootstrap and the workstation identity
migration helper.
"""
import argparse
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone


API = 'http://127.0.0.1:3000'
IDENTITY_PATH = pathlib.Path(os.environ.get(
    'NCC_IDENTITY_FILE', '/etc/ncc-server/operator-identity.json'))
DEFAULT_RELAYS = [
    'wss://relay.primal.net/',
    'wss://relay.ditto.pub/',
]


def die(message):
    raise RuntimeError(message)


def read_env(path):
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        values[key.strip()] = value.strip().strip('"\'')
    return values


def compose_command(project):
    base = ['docker', 'compose']
    if subprocess.run(base + ['version'], stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL).returncode:
        base = ['docker-compose']
    return base + ['-p', 'ncc-bundle', '-f', str(project / 'compose.yaml')]


def request(path, method='GET', payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        API + path, data=body, method=method,
        headers={'Content-Type': 'application/json'},
    )
    timeout = 60 if path == '/api/services/republish' else 30
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def atomic_write(path, data, mode=0o600):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if os.geteuid() == 0:
            os.chown(tmp, 0, 0)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def set_env_value(path, key, value):
    lines = path.read_text().splitlines()
    output = []
    found = False
    for line in lines:
        if line.startswith(key + '='):
            if not found:
                output.append(f'{key}={value}')
                found = True
        else:
            output.append(line)
    if not found:
        output.append(f'{key}={value}')
    atomic_write(path, '\n'.join(output) + '\n')


def update_relay_env(path, nsec, relay_url):
    if path.exists():
        lines = path.read_text().splitlines()
    else:
        # Compose deployments need a public URL for Relay's NIP-11 metadata.
        # It is operator configuration, not inferred from a private address.
        if not relay_url or not relay_url.startswith('wss://'):
            die('set PUBLIC_IPV4 in the project .env before first run')
        lines = [
            '# Root-owned Ditto Relay runtime configuration; do not commit.',
            f'RELAY_URL={relay_url}',
            'RELAY_PORT=127.0.0.1:13131',
            'IP_HEADER=X-Real-IP',
        ]
    replacements = {'NOSTR_SECRET_KEY': nsec}
    if relay_url:
        replacements['RELAY_URL'] = relay_url
    seen = set()
    output = []
    for line in lines:
        key = line.split('=', 1)[0] if '=' in line else None
        if key in replacements:
            if key not in seen:
                output.append(f'{key}={replacements[key]}')
                seen.add(key)
        else:
            output.append(line)
    for key, value in replacements.items():
        if key not in seen:
            output.append(f'{key}={value}')
    atomic_write(path, '\n'.join(output) + '\n')


def migrate_database(db_path, nsec, pubkey):
    with sqlite3.connect(db_path) as db:
        db.execute('BEGIN IMMEDIATE')
        # Dedicated service keys are deliberately independent of the operator
        # identity. Rotating them here would silently change their ncc://
        # addresses and discard the only copy of each key.
        db.execute(
            "UPDATE services SET service_nsec = ? "
            "WHERE COALESCE(json_extract(config, '$.service_identity'), '') != 'dedicated'",
            (nsec,),
        )
        db.execute('DELETE FROM admins')
        db.execute('INSERT INTO admins (pubkey, status) VALUES (?, ?)',
                   (pubkey, 'active'))
        db.commit()


def wait_for_sidecar(initialized, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            status = request('/api/setup/status')
            if status.get('initialized') == initialized:
                return
        except (OSError, urllib.error.URLError, json.JSONDecodeError):
            pass
        time.sleep(2)
    die('sidecar did not become ready in time')


def ensure_npanel_admin(compose, npub):
    result = subprocess.run(
        compose + ['exec', '-T', 'npanel', 'npanel', '--config',
                   '/tmp/npanel.toml', 'make-admin', npub],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        die('Npanel admin provisioning failed: ' + detail[-500:])


def configure_sidecar_defaults():
    request('/api/config/publication-relays', 'PUT', {'relays': DEFAULT_RELAYS})
    services = request('/api/services')
    manager = next((item for item in services if item.get('service_id') == 'manager'), None)
    if manager:
        config = manager.get('config') or {}
        protocols = config.get('protocols') or {}
        protocols['tor'] = False
        protocols.setdefault('ipv4', True)
        protocols.setdefault('ipv6', False)
        config['protocols'] = protocols
        config['publication_relays'] = DEFAULT_RELAYS
        request(f'/api/service/{manager["id"]}', 'PUT', {'config': config})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project-dir', required=True, type=pathlib.Path)
    parser.add_argument('--identity-file', type=pathlib.Path)
    args = parser.parse_args()
    project = args.project_dir.resolve()
    if os.geteuid() != 0:
        die('remote helper must run as root through sudo')
    if args.identity_file:
        identity_path = args.identity_file
        try:
            identity = json.loads(identity_path.read_text())
        finally:
            identity_path.unlink(missing_ok=True)
    else:
        identity = json.load(sys.stdin)
    nsec, npub, pubkey = (identity.get(name) for name in ('nsec', 'npub', 'pubkey'))
    if not all(isinstance(value, str) and value for value in (nsec, npub, pubkey)):
        die('stdin identity must contain nsec, npub, and pubkey')
    if len(pubkey) != 64 or any(c not in '0123456789abcdef' for c in pubkey):
        die('identity pubkey must be 64 lowercase hexadecimal characters')
    env_path = project / '.env'
    if not env_path.is_file():
        die(f'{env_path} is missing; deploy and configure the Compose bundle first')
    env = read_env(env_path)
    sidecar_dir = pathlib.Path(env.get('SIDECAR_DATA_DIR', '/var/lib/ncc-sidecar'))
    db_path = sidecar_dir / 'sidecar.db'
    relay_env = pathlib.Path(env.get('DITTO_ENV_FILE', '/etc/ncc-server/ditto-relay.env'))
    public_ip = env.get('PUBLIC_IPV4')
    relay_public_url = (f'wss://{public_ip}:{env.get("RELAY_TLS_PORT", "8444")}/relay/'
                        if public_ip else None)
    compose = compose_command(project)
    relay_env_existed = relay_env.exists()
    if not db_path.is_file():
        die(f'sidecar database not found at {db_path}; start the sidecar once before setup')
    if not pathlib.Path(env.get('NPANEL_DATA_DIR', '/var/lib/npanel')).is_dir():
        die('Npanel data directory is missing; start the Compose bundle before setup')
    if not relay_env_existed:
        if not relay_public_url or not relay_public_url.startswith('wss://'):
            die('set PUBLIC_IPV4 in the project .env before first run')
        atomic_write(relay_env, '\n'.join((
            '# Temporary first-run value; replaced before Relay is started.',
            f'RELAY_URL={relay_public_url}',
            'NOSTR_SECRET_KEY=setup-pending',
            'RELAY_PORT=127.0.0.1:13131',
            'IP_HEADER=X-Real-IP',
            '',
        )))
    project_env_original = env_path.read_text()
    set_env_value(env_path, 'NCC_OPERATOR_PUBKEY', pubkey)
    env['NCC_OPERATOR_PUBKEY'] = pubkey
    os.environ['NCC_OPERATOR_PUBKEY'] = pubkey
    try:
        subprocess.run(compose + ['config'], cwd=project, check=True,
                       stdout=subprocess.DEVNULL)
    except Exception:
        atomic_write(env_path, project_env_original)
        if not relay_env_existed:
            relay_env.unlink(missing_ok=True)
        raise

    current = request('/api/setup/status')
    was_initialized = bool(current.get('initialized'))
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup_dir = pathlib.Path('/var/backups/ncc-server') / f'identity-{stamp}'
    backup_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chown(backup_dir, 0, 0)
    atomic_write(backup_dir / 'project.env', project_env_original)

    # Back up the SQLite database with its online backup API while sidecar is
    # stopped. This includes WAL contents and is restorable as a single file.
    subprocess.run(compose + ['stop', 'sidecar', 'relay'], cwd=project,
                   check=True, stdout=subprocess.DEVNULL)
    identity_existed = IDENTITY_PATH.exists()
    try:
        source = sqlite3.connect(db_path)
        target = sqlite3.connect(backup_dir / 'sidecar.db')
        source.backup(target)
        target.close()
        source.close()
        os.chmod(backup_dir / 'sidecar.db', 0o600)
        if relay_env_existed:
            shutil.copy2(relay_env, backup_dir / 'ditto-relay.env')
            os.chmod(backup_dir / 'ditto-relay.env', 0o600)
        if identity_existed:
            shutil.copy2(IDENTITY_PATH, backup_dir / 'operator-identity.json')
            os.chmod(backup_dir / 'operator-identity.json', 0o600)

        if was_initialized:
            migrate_database(db_path, nsec, pubkey)
        update_relay_env(relay_env, nsec, relay_public_url)

        IDENTITY_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        atomic_write(IDENTITY_PATH, json.dumps(identity, indent=2) + '\n')
        subprocess.run(compose + ['up', '-d', 'sidecar', 'relay'], cwd=project,
                       check=True, stdout=subprocess.DEVNULL)
        wait_for_sidecar(initialized=was_initialized)

        if not was_initialized:
            result = request('/api/setup/init', 'POST', {
                'adminPubkey': pubkey,
                'isRecovery': True,
                'recoveryPayload': {'sidecar_nsec': nsec, 'service_id': 'manager'},
                'config': {
                    'service_mode': 'public',
                    'publication_relays': DEFAULT_RELAYS,
                    'protocols': {'ipv4': True, 'ipv6': False, 'tor': False},
                },
            })
            if not result.get('success'):
                die('sidecar first-run initialization failed')

        configure_sidecar_defaults()

        if was_initialized:
            try:
                publish = request('/api/services/republish', 'POST', {})
                failed = [item for item in publish.get('details', []) if not item.get('success')]
                if failed:
                    print(f'Warning: {len(failed)} sidecar service(s) did not republish; '
                          'identity migration completed, inspect sidecar logs.', file=sys.stderr)
            except (OSError, urllib.error.URLError, TimeoutError) as error:
                # Relay availability must not roll back a valid identity migration.
                print(f'Warning: locator republish did not finish ({error}); '
                      'identity migration completed. Retry publication after relay connectivity is restored.',
                      file=sys.stderr)

        ensure_npanel_admin(compose, npub)
        # A clean node has no web certificate yet; Caddy's TLS listeners wait
        # until provisioning creates the shared web certificate.
        if was_initialized:
            subprocess.run(compose + ['up', '-d'], cwd=project, check=True,
                           stdout=subprocess.DEVNULL)
        print(f'Applied operator identity {npub} to the Compose services.')
        print(f'Existing active sidecar service records migrated: {was_initialized}.')
        print(f'Protected server-side identity: {IDENTITY_PATH} (root, mode 0600).')
        print(f'Pre-migration backup: {backup_dir}')
        if not was_initialized:
            print('Fresh sidecar initialized. Create and publish the web and relay profiles before starting Caddy.')
    except Exception:
        # Restore the identity-bearing state before bringing the services back.
        subprocess.run(compose + ['stop', 'sidecar', 'relay'], cwd=project,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        db_backup = backup_dir / 'sidecar.db'
        env_backup = backup_dir / 'ditto-relay.env'
        project_env_backup = backup_dir / 'project.env'
        if project_env_backup.exists():
            shutil.copy2(project_env_backup, env_path)
            os.chown(env_path, 0, 0)
            os.chmod(env_path, 0o600)
        if db_backup.exists():
            for suffix in ('-wal', '-shm'):
                pathlib.Path(str(db_path) + suffix).unlink(missing_ok=True)
            shutil.copy2(db_backup, db_path)
            os.chown(db_path, int(env.get('SIDECAR_UID', '996')),
                     int(env.get('SIDECAR_GID', '995')))
            os.chmod(db_path, 0o600)
        if env_backup.exists():
            shutil.copy2(env_backup, relay_env)
            os.chown(relay_env, 0, 0)
            os.chmod(relay_env, 0o600)
        elif not relay_env_existed:
            relay_env.unlink(missing_ok=True)
        identity_backup = backup_dir / 'operator-identity.json'
        if identity_backup.exists():
            shutil.copy2(identity_backup, IDENTITY_PATH)
            os.chown(IDENTITY_PATH, 0, 0)
            os.chmod(IDENTITY_PATH, 0o600)
        elif not identity_existed:
            IDENTITY_PATH.unlink(missing_ok=True)
        subprocess.run(compose + ['up', '-d', 'sidecar', 'relay'], cwd=project,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        raise


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, sqlite3.Error, subprocess.CalledProcessError,
            urllib.error.URLError, json.JSONDecodeError) as error:
        print(f'Identity setup failed: {error}', file=sys.stderr)
        sys.exit(1)

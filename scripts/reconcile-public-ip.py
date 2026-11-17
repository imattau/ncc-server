#!/usr/bin/env python3
"""Reconcile Compose service locators when the host's public IPv4 changes."""
import fcntl
import ipaddress
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request


PROJECT = pathlib.Path(os.environ.get('NCC_PROJECT_DIR', pathlib.Path(__file__).parents[1]))
ENV_PATH = pathlib.Path(os.environ.get('NCC_PROJECT_ENV', PROJECT / '.env'))
STATE_DIR = pathlib.Path('/var/lib/ncc-server')
PENDING_PATH = STATE_DIR / 'public-ip-reconcile.json'
LOCK_PATH = pathlib.Path('/run/lock/ncc-public-ip-reconcile.lock')
API = os.environ.get('SIDECAR_ADMIN_URL', 'http://127.0.0.1:3000').rstrip('/')
SERVICE_IDS = ('web', 'relay', 'npanel', 'ditto', 'search', 'admin', 'addr')
IP_URL = 'https://api.ipify.org'


def read_env(path):
    result = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            result[key.strip()] = value.strip().strip('"\'')
    return result


def atomic_write(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        if os.geteuid() == 0:
            os.chown(temporary, 0, 0)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def set_env_value(path, key, value):
    lines = path.read_text().splitlines()
    output, found = [], False
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


def replace_ip(value, old_ip, new_ip):
    if isinstance(value, str):
        return value.replace(old_ip, new_ip), int(old_ip in value)
    if isinstance(value, list):
        updated, count = [], 0
        for item in value:
            item, replaced = replace_ip(item, old_ip, new_ip)
            updated.append(item)
            count += replaced
        return updated, count
    if isinstance(value, dict):
        updated, count = {}, 0
        for key, item in value.items():
            updated[key], replaced = replace_ip(item, old_ip, new_ip)
            count += replaced
        return updated, count
    return value, 0


def request(path, method='GET', payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        API + path, data=body, method=method,
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)


def detect_public_ip():
    result = subprocess.run(
        ['curl', '-4', '--fail', '--silent', '--show-error', '--max-time', '15', IP_URL],
        check=True, capture_output=True, text=True,
    )
    address = ipaddress.ip_address(result.stdout.strip())
    if address.version != 4 or not address.is_global:
        raise RuntimeError(f'public IP detection returned a non-public address: {address}')
    return str(address)


def compose_command():
    prefix = ['docker', 'compose']
    if subprocess.run(prefix + ['version'], stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL).returncode:
        prefix = ['docker-compose']
    return prefix + ['-p', 'ncc-bundle', '-f', str(PROJECT / 'compose.yaml')]


def update_profiles(old_ip, new_ip):
    services = request('/api/services')
    by_id = {item.get('service_id'): item for item in services}
    missing = [service_id for service_id in SERVICE_IDS if service_id not in by_id]
    if missing:
        raise RuntimeError('missing active sidecar service profile(s): ' + ', '.join(missing))
    for service_id in SERVICE_IDS:
        service = by_id[service_id]
        if service.get('status') != 'active':
            raise RuntimeError(f'{service_id} service profile is not active')
        config, count = replace_ip(service.get('config') or {}, old_ip, new_ip)
        if count == 0 and new_ip not in json.dumps(config):
            raise RuntimeError(f'{service_id} profile has no saved endpoint containing {old_ip}; refusing to publish an unverified address')
        request(f'/api/service/{service["id"]}', 'PUT', {'config': config})
        print(f'Updated sidecar profile {service_id} ({count} address reference(s)).')


def update_relay_env(path, old_ip, new_ip):
    if not path.exists():
        raise RuntimeError(f'Relay environment file is missing: {path}')
    content = path.read_text()
    if old_ip not in content and new_ip not in content:
        raise RuntimeError(f'Relay environment file does not contain the saved address {old_ip}')
    if old_ip in content:
        content = content.replace(old_ip, new_ip)
        if not content.endswith('\n'):
            content += '\n'
        atomic_write(path, content)


def republish():
    result = request('/api/services/republish', 'POST', {})
    by_record_id = {str(item.get('id')): item for item in request('/api/services')}
    details = result.get('details', [])
    failures = []
    for service_id in SERVICE_IDS:
        record = next(item for item in by_record_id.values()
                      if item.get('service_id') == service_id)
        detail = next((item for item in details
                       if str(item.get('serviceId')) == str(record['id'])), None)
        if not detail or not detail.get('success'):
            failures.append(f'{service_id}: {(detail or {}).get("error", "no success result")}')
    if failures:
        raise RuntimeError('locator publication failed: ' + '; '.join(failures))


def main():
    if os.geteuid() != 0:
        raise RuntimeError('run this reconciler as root')
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        env = read_env(ENV_PATH)
        relay_env_path = pathlib.Path(env.get('DITTO_ENV_FILE', '/etc/ncc-server/ditto-relay.env'))
        old_ip = env.get('PUBLIC_IPV4')
        if not old_ip:
            raise RuntimeError(f'PUBLIC_IPV4 is missing from {ENV_PATH}')
        new_ip = detect_public_ip()
        if PENDING_PATH.exists():
            pending = json.loads(PENDING_PATH.read_text())
            old_ip, new_ip = pending['old_ip'], pending['new_ip']
            print(f'Retrying pending public IP reconciliation: {old_ip} -> {new_ip}.')
        elif old_ip == new_ip:
            print(f'Public IPv4 is unchanged ({new_ip}); no reconciliation needed.')
            return
        else:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            atomic_write(PENDING_PATH, json.dumps({'old_ip': old_ip, 'new_ip': new_ip}) + '\n')
            print(f'Public IPv4 changed: {old_ip} -> {new_ip}.')

        update_profiles(old_ip, new_ip)
        set_env_value(ENV_PATH, 'PUBLIC_IPV4', new_ip)
        update_relay_env(relay_env_path, old_ip, new_ip)

        command = compose_command()
        subprocess.run(command + ['up', '-d', '--build', '--force-recreate',
                                  'caddy', 'npanel', 'relay', 'search-ui'],
                       cwd=PROJECT, check=True)
        republish()
        PENDING_PATH.unlink(missing_ok=True)
        print(f'Public IP reconciliation completed: {new_ip}; all five NCC locators republished.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError,
            urllib.error.URLError, StopIteration, json.JSONDecodeError) as error:
        print(f'Public IP reconciliation failed: {error}', file=sys.stderr)
        sys.exit(1)

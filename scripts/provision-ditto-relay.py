#!/usr/bin/env python3
"""Create the relay's NCC locator record and private Compose environment."""
import json
import os
import pathlib
import sys
import tempfile
import urllib.error
import urllib.request

API = 'http://127.0.0.1:3000'
ENV_PATH = pathlib.Path(os.environ.get('DITTO_ENV_FILE', '/etc/ncc-server/ditto-relay.env'))
IDENTITY_PATH = pathlib.Path(os.environ.get(
    'NCC_IDENTITY_FILE', '/etc/ncc-server/operator-identity.json'))
RELAY_SERVICE_ID = 'relay'


def request(path, method='GET', data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(
        API + path, data=body, method=method,
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def read_identity():
    if not IDENTITY_PATH.is_file():
        raise RuntimeError(f'operator identity file not found: {IDENTITY_PATH}; run first-run identity setup first')
    identity = json.loads(IDENTITY_PATH.read_text())
    if not identity.get('nsec') or not identity.get('npub'):
        raise RuntimeError(f'operator identity file is invalid: {IDENTITY_PATH}')
    return identity


def make_env(relay_url, nsec):
    content = '\n'.join((
        '# Root-owned Ditto Relay runtime configuration; do not commit.',
        f'RELAY_URL={relay_url}',
        f'NOSTR_SECRET_KEY={nsec}',
        'RELAY_PORT=127.0.0.1:13131',
        'IP_HEADER=X-Real-IP',
        '',
    ))
    ENV_PATH.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix='.ditto-relay.', dir=ENV_PATH.parent)
    try:
        with os.fdopen(fd, 'w') as env_file:
            env_file.write(content)
            env_file.flush()
            os.fsync(env_file.fileno())
        os.chown(temp_path, 0, 0)
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, ENV_PATH)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def main():
    if os.geteuid() != 0:
        raise RuntimeError('run with sudo or as root')
    if len(sys.argv) != 2:
        raise RuntimeError('usage: provision-ditto-relay.py wss://<public-address>:8444/')
    relay_url = sys.argv[1]
    if not relay_url.startswith('wss://') or ':8444' not in relay_url:
        raise RuntimeError('relay URL must use wss:// and port 8444')

    identity = read_identity()
    services = request('/api/services')
    relay_service = next((s for s in services if s.get('service_id') == RELAY_SERVICE_ID), None)
    if relay_service is not None and relay_service.get('type') != 'relay':
        raise RuntimeError('service ID relay already exists with a non-relay type; inspect the sidecar before proceeding')
    if relay_service is None:
        relay_service = request('/api/service/add', 'POST', {
            'type': 'relay',
            'name': 'Ditto Relay',
            'service_id': RELAY_SERVICE_ID,
            'service_nsec': identity['nsec'],
            'config': {
                'service_mode': 'public',
                'publication_relays': [
                    'wss://relay.primal.net/',
                    'wss://relay.ditto.pub/',
                ],
                'protocols': {'ipv4': True, 'ipv6': False, 'tor': False},
                'primary_protocol': 'ipv4',
                'preferred_protocol': 'wss',
                'port': 8444,
                'generate_self_signed': True,
                'probe_url': 'https://localhost:8444/',
                'ncc05_ttl_hours': 1,
                'ncc02_expiry_days': 1,
                'refresh_interval_minutes': 30,
                'ncc05_recipients': [],
            },
        })
        public_npub = identity.get('npub')
    else:
        request(f'/api/service/{relay_service["id"]}', 'PUT', {
            'service_nsec': identity['nsec'],
        })
        public_npub = identity.get('npub')

    if not ENV_PATH.exists():
        make_env(relay_url, identity['nsec'])
    else:
        # Keep the key stable on reruns. Only update the public URL if the
        # operator deliberately re-runs provisioning after an address change.
        env = ENV_PATH.read_text().splitlines()
        replacements = {'RELAY_URL': relay_url, 'NOSTR_SECRET_KEY': identity['nsec']}
        seen = set()
        output = []
        for line in env:
            if '=' in line and line.split('=', 1)[0] in replacements:
                key = line.split('=', 1)[0]
                if key not in seen:
                    output.append(f'{key}={replacements[key]}')
                    seen.add(key)
            else:
                output.append(line)
        for key, value in replacements.items():
            if key not in seen:
                output.append(f'{key}={value}')
        fd, temp_path = tempfile.mkstemp(prefix='.ditto-relay.', dir=ENV_PATH.parent)
        try:
            with os.fdopen(fd, 'w') as env_file:
                env_file.write('\n'.join(output) + '\n')
                env_file.flush()
                os.fsync(env_file.fileno())
            os.chown(temp_path, 0, 0)
            os.chmod(temp_path, 0o600)
            os.replace(temp_path, ENV_PATH)
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)

    publish_result = request('/api/services/republish', 'POST', {})
    failed = [detail for detail in publish_result.get('details', [])
              if str(detail.get('serviceId')) == str(relay_service['id']) and not detail.get('success')]
    if failed:
        raise RuntimeError('sidecar failed to publish the relay service; inspect ncc-sidecar logs')

    print(f"NCC relay service record: {relay_service['id']} (service ID: relay)")
    if public_npub:
        print(f'Relay service npub: {public_npub}')
    print(f'Runtime environment stored at {ENV_PATH} with mode 0600.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, urllib.error.URLError, KeyError, OSError) as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)

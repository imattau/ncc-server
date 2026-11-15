#!/usr/bin/env python3
"""Create the standard fresh-install sidecar service profiles."""
import base64
import hashlib
import json
import os
import pathlib
import re
import secrets
import socket
import subprocess
import sys
import time
import urllib.request


API = os.environ.get('SIDECAR_ADMIN_URL', 'http://127.0.0.1:3000').rstrip('/')
IDENTITY_PATH = pathlib.Path(os.environ.get(
    'NCC_IDENTITY_FILE', '/etc/ncc-server/operator-identity.json'))
RELAY_SCRIPT = pathlib.Path(__file__).with_name('provision-ditto-relay.py')
RELAYS = [
    'wss://relay.primal.net/',
    'wss://relay.ditto.pub/',
]


def request(path, method='GET', data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(
        API + path, data=body, method=method,
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=45) as response:
        return json.load(response)


def service_config(host, port, protocol, *, self_signed, pin=None):
    endpoint = f'{protocol}://{host}:{port}/'
    config = {
        'refresh_interval_minutes': 360,
        'ncc02_expiry_days': 14,
        'ncc05_ttl_hours': 12,
        'service_mode': 'public',
        'publication_relays': RELAYS,
        'generate_self_signed': self_signed,
        'protocols': {'ipv4': True, 'ipv6': False, 'tor': False},
        'primary_protocol': 'ipv4',
        'preferred_protocol': protocol,
        'port': port,
        'probe_url': endpoint,
        'ncc05_recipients': [],
    }
    if pin:
        config['ncc02ExpectedKey'] = pin
        config['endpoints'] = [{
            'url': endpoint,
            'family': 'ipv4',
            'protocol': protocol,
            'priority': 1,
            'k': pin,
        }]
    return config


def ensure_service(services, identity, *, service_id, name, config, service_type='custom'):
    current = next((item for item in services if item.get('service_id') == service_id), None)
    if current:
        result = request(f'/api/service/{current["id"]}', 'PUT', {
            'name': name,
            'service_nsec': identity['nsec'],
            'config': config,
            'status': 'active',
        })
        current.update(result)
        current['name'] = name
        current['config'] = config
        return current
    return request('/api/service/add', 'POST', {
        'type': service_type,
        'name': name,
        'service_id': service_id,
        'service_nsec': identity['nsec'],
        'config': config,
        'state': {},
    })


def force_publish(record):
    result = request('/api/services/republish', 'POST', {})
    detail = next((item for item in result.get('details', [])
                   if str(item.get('serviceId')) == str(record['id'])), None)
    if not detail or not detail.get('success'):
        reason = (detail or {}).get('error', 'sidecar returned no success for this record')
        raise RuntimeError(f'{record["service_id"]} locator publish failed: {reason}')


def spki_pin(cert_path):
    cert = subprocess.run(
        ['openssl', 'x509', '-in', str(cert_path), '-pubkey', '-noout'],
        check=True, capture_output=True,
    ).stdout
    der = subprocess.run(
        ['openssl', 'pkey', '-pubin', '-outform', 'DER'],
        input=cert, check=True, capture_output=True,
    ).stdout
    return base64.urlsafe_b64encode(hashlib.sha256(der).digest()).decode().rstrip('=')


def configure_tor(project, torrc_path):
    password = secrets.token_urlsafe(48)
    compose = ['docker-compose', '-p', 'ncc-bundle', '-f', str(project / 'compose.yaml')]
    result = subprocess.run(
        compose + ['exec', '-T', 'tor', 'tor', '--hash-password', password],
        check=True, capture_output=True, text=True,
    )
    hashed = next((line.strip() for line in result.stdout.splitlines()
                   if re.fullmatch(r'16:[A-F0-9]{58}', line.strip())), None)
    if not hashed:
        raise RuntimeError('Tor did not return a valid HashedControlPassword')
    torrc_path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    torrc_path.write_text('\n'.join((
        'SocksPort 127.0.0.1:9050',
        'ControlPort 127.0.0.1:9051',
        'CookieAuthentication 0',
        f'HashedControlPassword {hashed}',
        '',
    )))
    os.chown(torrc_path, 0, 0)
    os.chmod(torrc_path, 0o644)
    subprocess.run(compose + ['restart', 'tor'], check=True,
                   stdout=subprocess.DEVNULL)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(('127.0.0.1', 9051), timeout=2):
                return password
        except OSError:
            time.sleep(1)
    raise RuntimeError('Tor control port 9051 did not become ready')


def main():
    if os.geteuid() != 0:
        raise RuntimeError('run this service provisioner as root on the VM')
    if not IDENTITY_PATH.is_file():
        raise RuntimeError(f'shared identity file missing: {IDENTITY_PATH}')
    identity = json.loads(IDENTITY_PATH.read_text())
    if not identity.get('nsec') or not identity.get('npub'):
        raise RuntimeError('shared identity file is invalid')
    state = request('/api/setup/status')
    if not state.get('initialized'):
        raise RuntimeError('initialize the sidecar with make first-run-identity before adding services')

    env_path = pathlib.Path(os.environ.get('NCC_PROJECT_ENV', pathlib.Path(__file__).parents[1] / '.env'))
    env = {}
    for line in env_path.read_text().splitlines():
        if line and not line.lstrip().startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            env[key.strip()] = value.strip().strip('"\'')
    public_host = env.get('PUBLIC_ENDPOINT_HOST')
    dashboard_host = env.get('DASHBOARD_HOST')
    ditto_host = env.get('DITTO_WEB_HOST')
    if not all((public_host, dashboard_host, ditto_host)):
        raise RuntimeError('set PUBLIC_ENDPOINT_HOST, DASHBOARD_HOST, and DITTO_WEB_HOST in .env')
    http_port = int(env.get('CONTENT_PORT', '8080'))
    https_port = int(env.get('CONTENT_TLS_PORT', '8443'))
    relay_port = int(env.get('RELAY_TLS_PORT', '8444'))
    cert_dir = pathlib.Path(env.get('SIDECAR_CERT_DIR', '/opt/ncc-sidecar/certs'))
    project = pathlib.Path(__file__).parents[1]
    tor_password = configure_tor(project, pathlib.Path(env.get('TOR_CONFIG_FILE', '/etc/tor/torrc')))

    services = request('/api/services')
    web_config = service_config(public_host, https_port, 'https', self_signed=True)
    web_config['protocols']['tor'] = True
    web_config['local_port'] = http_port
    web_config['tor_control'] = {
        'enabled': True,
        'host': '127.0.0.1',
        'port': 9051,
        'password': tor_password,
    }
    web = ensure_service(services, identity, service_id='web', name='NCC Web', config=web_config)
    if int(web['id']) != 2:
        raise RuntimeError(f'web record must have ID 2 for the Caddy certificate path; got {web["id"]}')
    force_publish(web)

    relay_url = env.get('RELAY_PUBLIC_URL', f'wss://{public_host}:{relay_port}/')
    relay_env = os.environ.copy()
    relay_env['DITTO_ENV_FILE'] = env.get('DITTO_ENV_FILE', '/etc/ncc-server/ditto-relay.env')
    relay_env['NCC_IDENTITY_FILE'] = str(IDENTITY_PATH)
    subprocess.run([sys.executable, str(RELAY_SCRIPT), relay_url],
                   check=True, env=relay_env)
    services = request('/api/services')
    relay = next((item for item in services if item.get('service_id') == 'relay'), None)
    if not relay or int(relay['id']) != 3:
        raise RuntimeError(f'relay record must have ID 3 for the Caddy certificate path; got {relay and relay.get("id")}')

    cert_path = cert_dir / '2' / 'server.crt'
    if not cert_path.is_file():
        raise RuntimeError(f'web self-signed certificate was not generated: {cert_path}')
    pin = spki_pin(cert_path)
    services = request('/api/services')
    npanel = ensure_service(
        services, identity, service_id='npanel', name='Npanel Dashboard',
        config=service_config(dashboard_host, http_port, 'http', self_signed=False),
    )
    ditto = ensure_service(
        services, identity, service_id='ditto', name='Ditto Web',
        config=service_config(ditto_host, https_port, 'https', self_signed=False, pin=pin),
    )
    force_publish(npanel)
    force_publish(ditto)
    print(f'Provisioned shared-identity locators: web={web["id"]}, relay={relay["id"]}, '
          f'npanel={npanel["id"]}, ditto={ditto["id"]}.')
    print(f'Web SPKI pin: {pin}')
    current_web = next((item for item in request('/api/services')
                        if item.get('service_id') == 'web'), {})
    onion = (current_web.get('state') or {}).get('last_onion_address')
    if onion:
        print(f'Tor onion endpoint: http://{onion}/')
    print(f'All service records use operator npub {identity["npub"]}.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, KeyError, ValueError, json.JSONDecodeError,
            subprocess.CalledProcessError) as error:
        print(f'Compose service provisioning failed: {error}', file=sys.stderr)
        sys.exit(1)

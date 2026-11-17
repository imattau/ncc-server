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


def service_config(host, port, protocol, *, self_signed, pin=None,
                   path='/', probe_url=None):
    endpoint = f'{protocol}://{host}:{port}{path}'
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
        'probe_url': probe_url or endpoint,
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
    public_ip = env.get('PUBLIC_IPV4')
    if not public_ip:
        raise RuntimeError('set PUBLIC_IPV4 in .env')
    http_port = int(env.get('CONTENT_PORT', '8080'))
    https_port = int(env.get('CONTENT_TLS_PORT', '8443'))
    relay_port = int(env.get('RELAY_TLS_PORT', '8444'))
    ditto_port = int(env.get('DITTO_WEB_TLS_PORT', '8446'))
    npanel_port = int(env.get('NPANEL_TLS_PORT', '8445'))
    search_port = int(env.get('SEARCH_TLS_PORT', '8447'))
    admin_port = int(env.get('ADMIN_PANEL_TLS_PORT', '8448'))
    cert_dir = pathlib.Path(env.get('SIDECAR_CERT_DIR', '/opt/ncc-sidecar/certs'))
    project = pathlib.Path(__file__).parents[1]
    tor_password = configure_tor(project, pathlib.Path(env.get('TOR_CONFIG_FILE', '/etc/tor/torrc')))

    services = request('/api/services')
    web_config = service_config(public_ip, https_port, 'https', self_signed=True)
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

    cert_path = cert_dir / '2' / 'server.crt'
    if not cert_path.is_file():
        raise RuntimeError(f'web self-signed certificate was not generated: {cert_path}')
    pin = spki_pin(cert_path)

    services = request('/api/services')
    relay_existing = next((item for item in services if item.get('service_id') == 'relay'), None)
    if relay_existing and relay_existing.get('type') != 'relay':
        raise RuntimeError('service ID relay already exists with a non-relay type; inspect the sidecar before proceeding')
    relay_config = service_config(
        public_ip, relay_port, 'wss', self_signed=True, path='/relay/',
        # Probe the relay backend directly during first-run provisioning; Caddy
        # depends on the certificate and profiles created by this script.
        probe_url='http://127.0.0.1:13131/',
    )
    relay_config.update({
        'ncc05_ttl_hours': 1,
        'ncc02_expiry_days': 1,
        'refresh_interval_minutes': 30,
    })
    relay = ensure_service(
        services, identity, service_id='relay', name='Ditto Relay',
        config=relay_config, service_type='relay',
    )
    if not relay or int(relay['id']) != 3:
        raise RuntimeError(f'relay record must have ID 3; got {relay and relay.get("id")}')
    force_publish(relay)

    relay_cert_path = cert_dir / '3' / 'server.crt'
    if not relay_cert_path.is_file():
        raise RuntimeError(f'relay self-signed certificate was not generated: {relay_cert_path}')
    relay_pin = spki_pin(relay_cert_path)
    relay_config = service_config(
        public_ip, relay_port, 'wss', self_signed=True, pin=relay_pin, path='/relay/',
        probe_url='http://127.0.0.1:13131/',
    )
    relay_config.update({
        'ncc05_ttl_hours': 1,
        'ncc02_expiry_days': 1,
        'refresh_interval_minutes': 30,
    })
    relay = ensure_service(
        request('/api/services'), identity, service_id='relay', name='Ditto Relay',
        config=relay_config, service_type='relay',
    )
    force_publish(relay)

    services = request('/api/services')
    npanel = ensure_service(
        services, identity, service_id='npanel', name='Npanel Dashboard',
        config=service_config(
            public_ip, npanel_port, 'https', self_signed=False, pin=pin,
            probe_url='http://127.0.0.1:3200/api/instance',
        ),
    )
    ditto = ensure_service(
        services, identity, service_id='ditto', name='Ditto Web',
        config=service_config(
            public_ip, ditto_port, 'https', self_signed=False, pin=pin,
            probe_url='http://127.0.0.1:3210/',
        ),
    )
    # ncc-search (see ncc-search/README.md) needs no identity or signer of
    # its own -- it's read-only and never publishes an event -- but it
    # still gets an NCC-02 record here so it has a discoverable ncc://
    # address, the same way npanel/ditto-web do despite also not signing
    # anything themselves. Only the UI is addressed, not its separate API
    # backend, matching how npanel/ditto-web's own backend ports aren't
    # published individually either.
    search = ensure_service(
        services, identity, service_id='search', name='ncc-search',
        config=service_config(public_ip, search_port, 'https', self_signed=False, pin=pin),
    )
    force_publish(npanel)
    force_publish(ditto)
    force_publish(search)
    # The admin panel is part of the same SPA as the welcome page, so its
    # service endpoint is rooted at / and Caddy's admin listener serves a small
    # page that opens /admin. Probe the local HTTP content listener: the shared
    # web certificate is self-signed, and the sidecar only needs to know the
    # content is served. The panel itself is a prototype; see
    # docs/admin-panel.md.
    services = request('/api/services')
    admin = ensure_service(
        services, identity, service_id='admin', name='Admin Panel',
        config=service_config(
            public_ip, admin_port, 'https', self_signed=False, pin=pin,
            probe_url=f'http://127.0.0.1:{http_port}/admin',
        ),
    )
    force_publish(admin)
    # Bare ncc://<npub>/ resolves the default service `addr`. Keep this as a
    # distinct NCC-02 profile with its own d=addr locator, but point it at the
    # same public web endpoint and certificate as the named `web` service.
    services = request('/api/services')
    root = ensure_service(
        services, identity, service_id='addr', name='NCC Web Root',
        config={
            **service_config(public_ip, https_port, 'https', self_signed=False, pin=pin),
            'locator_id': 'addr',
        },
    )
    force_publish(root)
    print(f'Provisioned shared-identity locators: web={web["id"]}, relay={relay["id"]}, '
          f'npanel={npanel["id"]}, ditto={ditto["id"]}, search={search["id"]}, '
          f'admin={admin["id"]}, addr={root["id"]}.')
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

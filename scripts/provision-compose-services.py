#!/usr/bin/env python3
"""Create the standard fresh-install sidecar service profiles."""
import base64
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import urllib.request

import tor_control
from tor_settings import (
    RELAY_LOCAL_PORT,
    enable_service_tor,
    local_port_for,
    reuse_onion_endpoint,
)


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
    services = request('/api/services')
    tor_password = tor_control.configure(
        project,
        pathlib.Path(env.get('TOR_CONFIG_FILE', '/etc/tor/torrc')),
        services,
    )
    # A rotated control password drops every live onion. Update services this
    # script does not recreate (custom services) before publishing.
    for service, control in tor_control.password_updates(services, tor_password):
        request(f'/api/service/{service["id"]}', 'PUT', {
            'config': {'tor_control': {**control, 'password': tor_password}},
        })

    web_config = service_config(public_ip, https_port, 'https', self_signed=True)
    web_config = enable_service_tor(
        web_config, password=tor_password,
        local_port=local_port_for('web', env),
    )
    web = ensure_service(services, identity, service_id='web', name='NCC Web', config=web_config)
    if int(web['id']) != 2:
        raise RuntimeError(f'web record must have ID 2 for the Caddy certificate path; got {web["id"]}')
    force_publish(web)

    # The web onion is also the default `addr` endpoint, so remember it before
    # provisioning the rest.
    current_web = next((item for item in request('/api/services')
                        if item.get('service_id') == 'web'), {})
    web_onion = (current_web.get('state') or {}).get('last_onion_address')

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
    relay_config = enable_service_tor(
        relay_config, password=tor_password, local_port=RELAY_LOCAL_PORT,
    )
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
    relay_config = enable_service_tor(
        relay_config, password=tor_password, local_port=RELAY_LOCAL_PORT,
    )
    relay = ensure_service(
        request('/api/services'), identity, service_id='relay', name='Ditto Relay',
        config=relay_config, service_type='relay',
    )
    force_publish(relay)

    services = request('/api/services')
    npanel_config = service_config(
        public_ip, npanel_port, 'https', self_signed=False, pin=pin,
        probe_url='http://127.0.0.1:3200/api/instance',
    )
    npanel_config = enable_service_tor(
        npanel_config, password=tor_password, local_port=local_port_for('npanel', env),
    )
    npanel = ensure_service(
        services, identity, service_id='npanel', name='Npanel Dashboard',
        config=npanel_config,
    )
    ditto_config = service_config(
        public_ip, ditto_port, 'https', self_signed=False, pin=pin,
        probe_url='http://127.0.0.1:3210/',
    )
    ditto_config = enable_service_tor(
        ditto_config, password=tor_password, local_port=local_port_for('ditto', env),
    )
    ditto = ensure_service(
        services, identity, service_id='ditto', name='Ditto Web',
        config=ditto_config,
    )
    # ncc-search (see ncc-search/README.md) needs no identity or signer of
    # its own -- it's read-only and never publishes an event -- but it
    # still gets an NCC-02 record here so it has a discoverable ncc://
    # address, the same way npanel/ditto-web do despite also not signing
    # anything themselves. Only the UI is addressed, not its separate API
    # backend, matching how npanel/ditto-web's own backend ports aren't
    # published individually either.
    search_config = service_config(public_ip, search_port, 'https', self_signed=False, pin=pin)
    search_config = enable_service_tor(
        search_config, password=tor_password, local_port=local_port_for('search', env),
    )
    search = ensure_service(
        services, identity, service_id='search', name='ncc-search',
        config=search_config,
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
    admin_config = service_config(
        public_ip, admin_port, 'https', self_signed=False, pin=pin,
        probe_url=f'http://127.0.0.1:{http_port}/admin',
    )
    admin_config = enable_service_tor(
        admin_config, password=tor_password, local_port=local_port_for('admin', env),
    )
    admin = ensure_service(
        services, identity, service_id='admin', name='Admin Panel',
        config=admin_config,
    )
    force_publish(admin)
    # Bare ncc://<npub>/ resolves the default service `addr`. Keep this as a
    # distinct NCC-02 profile with its own d=addr locator, but point it at the
    # same public web endpoint and certificate as the named `web` service.
    # It reuses web's onion address instead of creating a second address for
    # the same page.
    root_config = {
        **service_config(public_ip, https_port, 'https', self_signed=False, pin=pin),
        'locator_id': 'addr',
    }
    if web_onion:
        root_config = reuse_onion_endpoint(root_config, web_onion)
    else:
        print('Warning: Tor did not return a web onion; addr will publish no onion endpoint.')
    services = request('/api/services')
    root = ensure_service(
        services, identity, service_id='addr', name='NCC Web Root',
        config=root_config,
    )
    force_publish(root)
    print(f'Provisioned shared-identity locators: web={web["id"]}, relay={relay["id"]}, '
          f'npanel={npanel["id"]}, ditto={ditto["id"]}, search={search["id"]}, '
          f'admin={admin["id"]}, addr={root["id"]}.')
    print(f'Web SPKI pin: {pin}')
    final_services = request('/api/services')
    for service_id in ('web', 'relay', 'npanel', 'ditto', 'search', 'admin'):
        record = next((item for item in final_services
                       if item.get('service_id') == service_id), None)
        onion = (record.get('state') or {}).get('last_onion_address') if record else None
        if onion:
            print(f'Tor onion for {service_id}: http://{onion}/')
        else:
            print(f'Warning: {service_id} has no onion address yet.')
    if web_onion:
        print(f'Tor onion for addr (shared with web): http://{web_onion}/')
    print(f'All service records use operator npub {identity["npub"]}.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, KeyError, ValueError, json.JSONDecodeError,
            subprocess.CalledProcessError) as error:
        print(f'Compose service provisioning failed: {error}', file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
"""Publish one Tor onion endpoint per public NCC service on a Compose host.

Fresh installs do this in provision-compose-services.py. Run this once on an
existing install after deploying the Caddy loopback listeners: it merges Tor
settings into the existing records instead of rewriting their profiles, relay
list or cadence.

The default `addr` profile shares the web page, so it advertises web's onion
rather than creating a second address for the same content.
"""

import json
import os
import pathlib
import socket
import sys
import urllib.error
import urllib.request

import tor_control
from tor_settings import (
    enable_service_tor,
    local_port_for,
    reuse_onion_endpoint,
)

PROJECT = pathlib.Path(__file__).resolve().parents[1]
API = os.environ.get('SIDECAR_ADMIN_URL', 'http://127.0.0.1:3000').rstrip('/')

STANDARD_SERVICES = ('web', 'relay', 'npanel', 'ditto', 'search', 'admin')


def fail(message):
    raise RuntimeError(message)


def api(path, method='GET', body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        API + path, data=data, method=method,
        headers={'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors='replace')[:500]
        fail(f'sidecar API {path} returned HTTP {error.code}: {detail}')


def read_env():
    env_path = pathlib.Path(os.environ.get('NCC_PROJECT_ENV', PROJECT / '.env'))
    if not env_path.is_file():
        fail(f'{env_path} is missing; run this on the installed Compose host')
    env = {}
    for line in env_path.read_text().splitlines():
        if line and not line.lstrip().startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            env[key.strip()] = value.strip().strip('"\'')
    return env


def require_listener(port, label):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=3):
            return
    except OSError as error:
        fail(
            f'127.0.0.1:{port} ({label}) is not listening. Deploy the release '
            f'with the Caddy loopback listeners and recreate the caddy '
            f'container before enabling Tor. Original error: {error}'
        )


def services_by_id():
    return {service.get('service_id'): service for service in api('/api/services')}


def apply_tor(record, config):
    update = {
        'protocols': config['protocols'],
        'tor_control': config['tor_control'],
        'onion_address': config.get('onion_address'),
    }
    if 'local_port' in config:
        update['local_port'] = config['local_port']
    api(f'/api/service/{record["id"]}', 'PUT', {'config': update})


def publish_all():
    result = api('/api/services/republish', method='POST', body={})
    failures = [detail for detail in result.get('details', [])
                if not detail.get('success')]
    if failures:
        summary = '; '.join(
            f'{item.get("serviceId")}: {item.get("error", "publish failed")}'
            for item in failures
        )
        fail(f'sidecar republish failed: {summary}')


def main():
    if os.geteuid() != 0:
        fail('run this command as root on the NCC-Server host')

    env = read_env()
    services = services_by_id()
    missing = [service_id for service_id in STANDARD_SERVICES if service_id not in services]
    if missing:
        fail(
            'missing service records: ' + ', '.join(missing)
            + '. Run `sudo make bundle-provision-services` first if this install '
              'predates those records.'
        )

    ports = {service_id: local_port_for(service_id, env)
             for service_id in STANDARD_SERVICES}
    require_listener(ports['web'], 'web content')
    require_listener(ports['relay'], 'relay backend')
    for service_id in ('npanel', 'ditto', 'search', 'admin'):
        require_listener(ports[service_id], f'{service_id} Tor listener')

    password = tor_control.configure(
        PROJECT,
        pathlib.Path(env.get('TOR_CONFIG_FILE', '/etc/tor/torrc')),
        list(services.values()),
    )

    # A rotated control password drops every live onion. Update services the
    # standard loop below does not touch (custom services) as well.
    for service, control in tor_control.password_updates(services.values(), password):
        api(f'/api/service/{service["id"]}', 'PUT', {
            'config': {'tor_control': {**control, 'password': password}},
        })

    for service_id in STANDARD_SERVICES:
        record = services[service_id]
        config = enable_service_tor(
            record.get('config') or {},
            password=password,
            local_port=ports[service_id],
        )
        apply_tor(record, config)
        print(f'Enabled Tor for {service_id} -> 127.0.0.1:{ports[service_id]}')

    publish_all()
    services = services_by_id()

    web_onion = ((services.get('web') or {}).get('state') or {}).get('last_onion_address')
    if not web_onion:
        fail('Tor did not return an onion address for web; inspect the sidecar logs')

    root = services.get('addr')
    if root:
        config = reuse_onion_endpoint(root.get('config') or {}, web_onion)
        apply_tor(root, config)
        publish_all()
        services = services_by_id()
        print(f'addr reuses web onion http://{web_onion}/')
    else:
        print('Warning: no addr service record; bare ncc://<npub>/ has no onion endpoint')

    print('')
    print('Published onion endpoints:')
    missing = []
    for service_id in STANDARD_SERVICES:
        record = services.get(service_id) or {}
        onion = (record.get('state') or {}).get('last_onion_address')
        if onion:
            scheme = 'ws' if service_id == 'relay' else 'http'
            print(f'  {service_id:7} {scheme}://{onion}/')
        else:
            missing.append(service_id)
            print(f'  {service_id:7} MISSING - inspect the sidecar logs')

    print('')
    print('Tor may need a few minutes to publish the new descriptors.')
    if missing:
        fail('no onion address was published for: ' + ', '.join(missing))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, KeyError, ValueError,
            json.JSONDecodeError, urllib.error.URLError) as error:
        print(f'Tor enablement failed: {error}', file=sys.stderr)
        sys.exit(1)

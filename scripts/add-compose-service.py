#!/usr/bin/env python3
"""Install a custom Compose image and publish it as an NCC service."""
import hashlib
import ipaddress
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


PROJECT = pathlib.Path(__file__).resolve().parents[1]
IDENTITY_PATH = pathlib.Path(os.environ.get(
    'NCC_IDENTITY_FILE', '/etc/ncc-server/operator-identity.json'))
API = os.environ.get('SIDECAR_ADMIN_URL', 'http://127.0.0.1:3000').rstrip('/')
COMPOSE = ['docker-compose', '-p', 'ncc-bundle', '-f', str(PROJECT / 'compose.yaml')]
ID_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')


def fail(message):
    raise RuntimeError(message)


def run(args, *, env=None, capture=False):
    return subprocess.run(args, cwd=PROJECT, env=env, check=True,
                          text=True, capture_output=capture)


def api(path, method='GET', body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors='replace')[:500]
        fail(f'sidecar API {path} returned HTTP {error.code}: {detail}')


def reserve_port(port, label):
    with socket.socket() as sock:
        try:
            sock.bind(('0.0.0.0' if label == 'public' else '127.0.0.1', port))
        except OSError:
            fail(f'{label} port {port} is already in use')


def fingerprint(cert):
    public_key = subprocess.run(
        ['openssl', 'x509', '-in', str(cert), '-pubkey', '-noout'],
        check=True, capture_output=True,
    ).stdout
    der = subprocess.run(
        ['openssl', 'pkey', '-pubin', '-outform', 'DER'], input=public_key,
        check=True, capture_output=True,
    ).stdout
    import base64
    return base64.urlsafe_b64encode(hashlib.sha256(der).digest()).decode().rstrip('=')


def wait_backend(port, path):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=3) as response:
                if response.status < 500:
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(2)
    fail(f'backend did not become healthy at http://127.0.0.1:{port}{path}')


def main():
    if os.geteuid() != 0:
        fail('run this command as root on the NCC-Server host')
    if len(sys.argv) != 2:
        fail('usage: sudo make service-add PACKAGE=/path/to/service-package')
    package = pathlib.Path(sys.argv[1]).expanduser().resolve()
    manifest_path = package / 'service.json'
    compose_path = package / 'compose.yaml'
    if not manifest_path.is_file() or not compose_path.is_file():
        fail('package must contain service.json and compose.yaml')
    spec = json.loads(manifest_path.read_text())

    service_id = spec.get('service_id', '')
    name = spec.get('name', '')
    compose_service = spec.get('compose_service', '')
    image = spec.get('image', '')
    public_port = spec.get('public_port')
    backend_port = spec.get('backend_port')
    container_port = spec.get('container_port')
    probe_path = spec.get('probe_path', '/')
    if not isinstance(service_id, str) or not ID_RE.fullmatch(service_id):
        fail('service_id must be lowercase letters, digits, and hyphens')
    if service_id in {'web', 'relay', 'npanel', 'ditto', 'search'}:
        fail(f'{service_id} is reserved by NCC-Server')
    if not isinstance(name, str) or not name.strip():
        fail('name must be a non-empty string')
    if not isinstance(compose_service, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', compose_service):
        fail('compose_service must be a simple Compose service name')
    if not isinstance(image, str) or not image.strip():
        fail('image must name a container image')
    for key, value in [('public_port', public_port), ('backend_port', backend_port),
                       ('container_port', container_port)]:
        if not isinstance(value, int) or not 1 <= value <= 65535:
            fail(f'{key} must be a TCP port from 1 through 65535')
    if not isinstance(probe_path, str) or not probe_path.startswith('/') or any(c in probe_path for c in '\r\n"'):
        fail('probe_path must be an absolute URL path')
    if public_port in {8080, 8443, 8444, 8445, 8446, 8447, 8448}:
        fail(f'public port {public_port} is reserved by NCC-Server')
    if backend_port == public_port:
        fail('public_port and backend_port must be different')

    env_file = PROJECT / '.env'
    if not env_file.is_file():
        fail('run this on the installed NCC-Server host with its .env file present')
    env_values = {}
    for line in env_file.read_text().splitlines():
        if line and not line.lstrip().startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            env_values[key.strip()] = value.strip().strip('"\'')
    public_ip = env_values.get('PUBLIC_IPV4', '')
    try:
        ipaddress.IPv4Address(public_ip)
    except ipaddress.AddressValueError:
        fail('PUBLIC_IPV4 must be set in .env')
    identity = json.loads(IDENTITY_PATH.read_text())
    if not identity.get('nsec') or not identity.get('npub'):
        fail(f'operator identity is missing or invalid: {IDENTITY_PATH}')

    target = PROJECT / 'custom-services' / 'packages' / service_id
    route = PROJECT / 'custom-services' / 'caddy' / f'{service_id}.caddy'
    staged_before = target.exists()
    if staged_before:
        staged_manifest = target / 'service.json'
        if not staged_manifest.is_file() or json.loads(staged_manifest.read_text()) != spec:
            fail(f'{target} already contains a different or incomplete service package; inspect it before retrying')
    if not staged_before:
        reserve_port(public_port, 'public')
        reserve_port(backend_port, 'backend')
    cert_dir = pathlib.Path(env_values.get('SIDECAR_CERT_DIR', '/opt/ncc-sidecar/certs'))
    cert = cert_dir / '2' / 'server.crt'
    key = cert_dir / '2' / 'server.key'
    if not cert.is_file() or not key.is_file():
        fail(f'the web service certificate is missing under {cert_dir}; provision the base bundle first')
    pin = fingerprint(cert)

    target.parent.mkdir(parents=True, exist_ok=True)
    route.parent.mkdir(parents=True, exist_ok=True)
    if not staged_before:
        shutil.copytree(package, target)
    compose_text = (target / 'compose.yaml').read_text()
    expected_mapping = '127.0.0.1:${CUSTOM_SERVICE_BACKEND_PORT}:${CUSTOM_SERVICE_CONTAINER_PORT}'
    if not staged_before:
        if expected_mapping not in compose_text:
            fail(f'compose.yaml must bind its backend with {expected_mapping!r}')
        substitutions = {
            '${CUSTOM_SERVICE_IMAGE}': image,
            '${CUSTOM_SERVICE_BACKEND_PORT}': str(backend_port),
            '${CUSTOM_SERVICE_CONTAINER_PORT}': str(container_port),
            '${CUSTOM_SERVICE_PROBE_PATH}': probe_path,
        }
        for token, value in substitutions.items():
            compose_text = compose_text.replace(token, value)
        (target / 'compose.yaml').write_text(compose_text)
    route_text = f'''# Generated for NCC service {service_id}. Edit via service package tooling.
:{public_port} {{
\ttls /opt/ncc-sidecar/certs/2/server.crt /opt/ncc-sidecar/certs/2/server.key
\theader Access-Control-Allow-Origin "*"
\treverse_proxy 127.0.0.1:{backend_port}
}}
'''
    route.write_text(route_text)

    custom_compose = target / 'compose.yaml'
    package_compose = COMPOSE + ['-f', str(custom_compose)]
    try:
        services = run(package_compose + ['config', '--services'], capture=True).stdout.split()
        base_services = run(COMPOSE + ['config', '--services'], capture=True).stdout.split()
        if compose_service not in services or compose_service in base_services:
            fail(f'compose_service {compose_service!r} must exist in the package and must not replace a bundle service')
        for manifest in (PROJECT / 'custom-services' / 'packages').glob('*/service.json'):
            other = json.loads(manifest.read_text())
            if other.get('service_id') != service_id and other.get('compose_service') == compose_service:
                fail(f'compose_service name {compose_service!r} is already used by {other.get("service_id")}')
        run([str(PROJECT / 'scripts' / 'compose-bundle.sh'), 'pull', compose_service])
        run([str(PROJECT / 'scripts' / 'compose-bundle.sh'), 'up', '-d', compose_service])
        wait_backend(backend_port, probe_path)

        cert_fingerprint = pin
        endpoint = f'https://{public_ip}:{public_port}/'
        config = {
            'refresh_interval_minutes': 360,
            'ncc02_expiry_days': 14,
            'ncc05_ttl_hours': 12,
            'service_mode': 'public',
            'publication_relays': ['wss://relay.primal.net/', 'wss://relay.ditto.pub/'],
            'generate_self_signed': False,
            'protocols': {'ipv4': True, 'ipv6': False, 'tor': False},
            'primary_protocol': 'ipv4',
            'preferred_protocol': 'https',
            'port': public_port,
            'probe_url': f'http://127.0.0.1:{backend_port}{probe_path}',
            'ncc05_recipients': [],
            'ncc02ExpectedKey': cert_fingerprint,
            'endpoints': [{'url': endpoint, 'family': 'ipv4', 'protocol': 'https',
                           'priority': 1, 'k': cert_fingerprint}],
        }
        existing = api('/api/services')
        record = next((item for item in existing if item.get('service_id') == service_id), None)
        if record:
            record = api(f'/api/service/{record["id"]}', 'PUT', {
                'name': name, 'service_nsec': identity['nsec'], 'config': config,
                'status': 'active',
            })
        else:
            record = api('/api/service/add', 'POST', {
                'type': 'custom', 'name': name, 'service_id': service_id,
                'service_nsec': identity['nsec'], 'config': config, 'state': {},
            })
        run([str(PROJECT / 'scripts' / 'compose-bundle.sh'), 'exec', '-T', 'caddy', 'caddy', 'reload', '--config',
                       '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])
        published = api('/api/services/republish', 'POST', {})
        detail = next((item for item in published.get('details', [])
                       if str(item.get('serviceId')) == str(record.get('id'))), None)
        if not detail or not detail.get('success'):
            fail(f'locator publish failed: {(detail or {}).get("error", "no success response")}')
        run(['curl', '--fail', '--silent', '--show-error', '--insecure',
             '--max-time', '15', '--resolve', f'{public_ip}:{public_port}:127.0.0.1',
             f'https://{public_ip}:{public_port}{probe_path}'])
    except Exception:
        # Keep staged files and the container for inspection if provisioning
        # or publication fails; rerunning with the same manifest resumes it.
        raise

    print(f'Installed {name} ({service_id}) from image {image}.')
    print(f'NCC address: ncc://{identity["npub"]}/{service_id}/')
    print(f'Public endpoint: {endpoint}')
    print(f'Allow and forward TCP {public_port} if external access is intended.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, KeyError, ValueError, json.JSONDecodeError,
            subprocess.CalledProcessError) as error:
        print(f'Custom service install failed: {error}', file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
"""Install a custom Compose service and publish it as an NCC service.

Three sources are accepted:

  --package DIR   a local package with service.json and compose.yaml
  --ref REF       a signed npack package: <publisher>/<name>[@<version>]
  --npk FILE      a local .npk descriptor file (unsigned, for development)

The npack path resolves the signed release through the local sidecar, which
downloads the artifact from Blossom, verifies its SHA-256 against the signed
event, and extracts the descriptor. The OCI image is then pulled as usual;
npack only distributes metadata and never supplies container bytes.

The Compose fragment for an npack package is generated from the descriptor,
not taken from the package, so a publisher cannot ask for host networking,
extra capabilities or bind mounts.
"""

import argparse
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
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

import tor_control
from ncc_service_spec import (
    DescriptorError,
    render_compose,
    validate_descriptor,
)
from tor_settings import enable_service_tor


PROJECT = pathlib.Path(__file__).resolve().parents[1]
IDENTITY_PATH = pathlib.Path(os.environ.get(
    'NCC_IDENTITY_FILE', '/etc/ncc-server/operator-identity.json'))
API = os.environ.get('SIDECAR_ADMIN_URL', 'http://127.0.0.1:3000').rstrip('/')
COMPOSE = ['docker-compose', '-p', 'ncc-bundle', '-f', str(PROJECT / 'compose.yaml')]
KIND = 'ncc-service'
PUBLISHER_RE = re.compile(r'^(?:npub1[0-9a-z]{20,}|[0-9a-f]{64})$', re.IGNORECASE)


def fail(message):
    raise RuntimeError(message)


def run(args, *, env=None, capture=False):
    return subprocess.run(args, cwd=PROJECT, env=env, check=True,
                          text=True, capture_output=capture)


def api(path, method='GET', body=None, timeout=45):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors='replace')[:500]
        fail(f'sidecar API {path} returned HTTP {error.code}: {detail}')
    except urllib.error.URLError as error:
        fail(f'could not reach the sidecar at {API}: {error.reason}')


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


def read_env():
    env_file = PROJECT / '.env'
    if not env_file.is_file():
        fail('run this on the installed NCC-Server host with its .env file present')
    values = {}
    for line in env_file.read_text().splitlines():
        if line and not line.lstrip().startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('"\'')
    return values


def load_local_package(package):
    """An operator-authored package keeps its own compose.yaml."""
    package = pathlib.Path(package).expanduser().resolve()
    manifest_path = package / 'service.json'
    compose_path = package / 'compose.yaml'
    if not manifest_path.is_file() or not compose_path.is_file():
        fail('package must contain service.json and compose.yaml')

    spec = json.loads(manifest_path.read_text())
    try:
        # Local packages may still use a mutable tag; the digest requirement
        # applies to signed packages, where the descriptor is what pins bytes.
        normalized = validate_descriptor(spec, require_digest=False)
    except DescriptorError as error:
        fail(str(error))
    return {
        'spec': normalized,
        'compose': compose_path.read_text(),
        'package_dir': package,
        'provenance': None,
        'readme': None,
        'signed': False,
    }


def read_metadata(path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def load_npk(npk_path):
    """Extract a local .npk. It carries no publisher signature."""
    npk_path = pathlib.Path(npk_path).expanduser().resolve()
    if not npk_path.is_file():
        fail(f'{npk_path} does not exist')

    work = pathlib.Path(tempfile.mkdtemp(prefix='ncc-npk-install-'))
    try:
        try:
            listing = subprocess.run(
                ['tar', '--zstd', '-tf', str(npk_path)],
                check=True, text=True, capture_output=True,
            ).stdout.split('\n')
        except FileNotFoundError:
            fail('tar is required to read a local .npk; install zstd, or use --ref')
        except subprocess.CalledProcessError as error:
            fail(f'could not read {npk_path}: {(error.stderr or "").strip()}')

        for member in filter(None, listing):
            if member.startswith('/') or '..' in member.split('/'):
                fail('package contains an unsafe path')

        root = work / 'unpacked'
        root.mkdir()
        subprocess.run(
            ['tar', '--zstd', '-xf', str(npk_path), '-C', str(root),
             '--no-same-owner', '--no-same-permissions'],
            check=True, text=True, capture_output=True,
        )

        services = root / 'share' / 'ncc-server' / 'services'
        directories = [entry for entry in services.iterdir()
                       if entry.is_dir() and not entry.is_symlink()] \
            if services.is_dir() else []
        if len(directories) != 1:
            fail('package must contain exactly one NCC service descriptor')

        directory = directories[0]
        descriptor_path = directory / 'service.json'
        if descriptor_path.is_symlink() or not descriptor_path.is_file():
            fail('package service.json is missing or not a regular file')
        spec = json.loads(descriptor_path.read_text())
        if spec.get('service_id') != directory.name:
            fail('service.json service_id does not match its package directory')

        metadata = read_metadata(root / '.npack' / 'manifest.json')
        if metadata.get('kind') != KIND:
            fail(f'package is not a {KIND} artifact')
        if not PUBLISHER_RE.fullmatch(str(metadata.get('publisher', ''))):
            fail('package manifest has no publisher key')

        try:
            normalized = validate_descriptor(spec, require_digest=True)
        except DescriptorError as error:
            fail(str(error))

        readme = directory / 'README.md'
        return {
            'spec': normalized,
            'compose': render_compose(normalized),
            'package_dir': None,
            'provenance': {
                'publisher': metadata.get('publisher'),
                'name': metadata.get('name'),
                'version': metadata.get('version'),
                'release_event_id': None,
                'artifact_sha256': hashlib.sha256(npk_path.read_bytes()).hexdigest(),
                'verified': False,
                'source': 'local-npk',
            },
            'readme': readme.read_text()
            if readme.is_file() and not readme.is_symlink() else None,
            'signed': False,
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


def load_ref(ref):
    """Resolve a signed npack package through the sidecar."""
    if not ref.strip():
        fail('--ref needs <publisher>/<name>[@<version>]')
    query = urllib.parse.urlencode({'ref': ref.strip()})
    payload = api(f'/api/npack/service?{query}', timeout=180)

    provenance = payload.get('provenance') or {}
    if not PUBLISHER_RE.fullmatch(str(provenance.get('publisher', ''))):
        fail('the sidecar returned no publisher for this package')
    if provenance.get('verified') is not True:
        fail('the sidecar could not verify the package signature')

    spec = payload.get('descriptor')
    try:
        normalized = validate_descriptor(spec, require_digest=True)
    except DescriptorError as error:
        fail(f'{ref}: {error}')

    return {
        'spec': normalized,
        'compose': render_compose(normalized),
        'package_dir': None,
        'provenance': {
            'publisher': provenance.get('publisher'),
            'npub': provenance.get('npub'),
            'name': provenance.get('name'),
            'version': provenance.get('version'),
            'release_event_id': provenance.get('releaseEventId'),
            'artifact_event_id': provenance.get('artifactEventId'),
            'artifact_sha256': provenance.get('sha256'),
            'verified': True,
            'source': 'npack',
        },
        'readme': payload.get('readme'),
        'signed': True,
        'warnings': payload.get('warnings') or [],
    }


def confirm(source):
    spec = source['spec']
    provenance = source['provenance'] or {}
    print(f"Install {spec['name']} ({spec['service_id']})")
    if provenance.get('version'):
        print(f"  package   {provenance.get('version')}")
    print(f"  publisher {provenance.get('npub') or provenance.get('publisher') or 'local package'}")
    print(f"  image     {spec['image']}")
    print(f"  ports     127.0.0.1:{spec['backend_port']} -> public {spec['public_port']}")
    for warning in source.get('warnings') or []:
        print(f'  warning   {warning}')
    if not source['signed']:
        print('  warning   this package is not publisher-signed')

    if not sys.stdin.isatty():
        fail('refusing to install from a package without a terminal; pass --yes to confirm')
    answer = input('Continue? [y/N] ').strip().lower()
    if answer not in {'y', 'yes'}:
        fail('installation cancelled')


def stage_files(source, target):
    """Write the package into custom-services/packages/<id>."""
    spec = source['spec']
    provenance = source['provenance']

    if target.exists():
        staged = read_metadata(target / 'service.json')
        try:
            normalized = validate_descriptor(staged, require_digest=False)
        except DescriptorError:
            normalized = None
        if normalized != spec:
            fail(f'{target} already contains a different or incomplete service package; '
                 'inspect it before retrying')
        if provenance and read_metadata(target / 'npack.json') != provenance:
            fail(f'{target} was installed from a different package release; '
                 'remove it before changing versions')
        return

    if source['package_dir']:
        shutil.copytree(source['package_dir'], target)
        return

    target.mkdir(parents=True, exist_ok=True)
    (target / 'service.json').write_text(
        json.dumps(spec, indent=2, sort_keys=True) + '\n')
    (target / 'compose.yaml').write_text(source['compose'])
    if provenance:
        (target / 'npack.json').write_text(
            json.dumps(provenance, indent=2, sort_keys=True) + '\n')
    if source.get('readme'):
        (target / 'README.md').write_text(source['readme'])


def install(source):
    spec = source['spec']
    service_id = spec['service_id']
    name = spec['name']
    compose_service = spec['compose_service']
    image = spec['image']
    public_port = spec['public_port']
    backend_port = spec['backend_port']
    container_port = spec['container_port']
    probe_path = spec['probe_path']

    env_values = read_env()
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
    stage_files(source, target)

    compose_text = (target / 'compose.yaml').read_text()
    expected_mapping = '127.0.0.1:${CUSTOM_SERVICE_BACKEND_PORT}:${CUSTOM_SERVICE_CONTAINER_PORT}'
    if source['package_dir'] and not staged_before:
        # Local packages keep their own compose.yaml and env placeholders.
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
            other = read_metadata(manifest)
            if other.get('service_id') != service_id and other.get('compose_service') == compose_service:
                fail(f'compose_service name {compose_service!r} is already used by {other.get("service_id")}')

        run([str(PROJECT / 'scripts' / 'compose-bundle.sh'), 'pull', compose_service])
        run([str(PROJECT / 'scripts' / 'compose-bundle.sh'), 'up', '-d', compose_service])
        wait_backend(backend_port, probe_path)

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
            'health_url': f'http://127.0.0.1:{backend_port}{probe_path}',
            'compose_services': [compose_service],
            'ncc05_recipients': [],
            'ncc02ExpectedKey': pin,
            'endpoints': [{'url': endpoint, 'family': 'ipv4', 'protocol': 'https',
                           'priority': 1, 'k': pin}],
        }
        if source['provenance']:
            config['npack'] = source['provenance']

        existing = api('/api/services')
        tor_password = tor_control.configure(
            PROJECT,
            pathlib.Path(env_values.get('TOR_CONFIG_FILE', '/etc/tor/torrc')),
            existing,
        )
        # A rotated control password drops every live onion; update other
        # services before the republish below so they re-add theirs too.
        for service, control in tor_control.password_updates(existing, tor_password):
            api(f'/api/service/{service["id"]}', 'PUT', {
                'config': {'tor_control': {**control, 'password': tor_password}},
            })
        config = enable_service_tor(
            config, password=tor_password, local_port=backend_port,
        )
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
        run([str(PROJECT / 'scripts' / 'compose-bundle.sh'), 'exec', '-T', 'caddy', 'caddy',
             'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])
        published = api('/api/services/republish', 'POST', {}, timeout=600)
        detail = next((item for item in published.get('details', [])
                       if str(item.get('serviceId')) == str(record.get('id'))), None)
        if not detail or not detail.get('success'):
            fail(f'locator publish failed: {(detail or {}).get("error", "no success response")}')
        published_record = next((item for item in api('/api/services')
                                 if item.get('service_id') == service_id), {})
        onion = (published_record.get('state') or {}).get('last_onion_address')
        run(['curl', '--fail', '--silent', '--show-error', '--insecure',
             '--max-time', '15', '--resolve', f'{public_ip}:{public_port}:127.0.0.1',
             f'https://{public_ip}:{public_port}{probe_path}'])
    except Exception:
        # Keep staged files and the container for inspection if provisioning
        # or publication fails; rerunning with the same package resumes it.
        raise

    print(f'Installed {name} ({service_id}) from image {image}.')
    print(f'NCC address: ncc://{identity["npub"]}/{service_id}/')
    print(f'Public endpoint: {endpoint}')
    if source['provenance']:
        print(f"Package: {source['provenance'].get('version')} "
              f"from {source['provenance'].get('npub') or source['provenance'].get('publisher')}")
    if onion:
        print(f'Tor onion endpoint: http://{onion}/')
    else:
        print('Warning: Tor did not return an onion address; inspect the sidecar logs.')
    print(f'Allow and forward TCP {public_port} if external access is intended.')


def main():
    parser = argparse.ArgumentParser(
        description='Install a custom NCC service from a package, npack reference or .npk')
    parser.add_argument('package', nargs='?', help='local package directory')
    parser.add_argument('--ref', help='signed npack reference: <publisher>/<name>[@version]')
    parser.add_argument('--npk', help='local .npk descriptor file')
    parser.add_argument('--yes', action='store_true',
                        help='skip the publisher confirmation prompt')
    args = parser.parse_args()

    sources = [bool(args.package), bool(args.ref), bool(args.npk)]
    if sum(sources) != 1:
        parser.error('pass exactly one of PACKAGE, --ref, or --npk')
    if os.geteuid() != 0:
        fail('run this command as root on the NCC-Server host')

    if args.package:
        source = load_local_package(args.package)
    elif args.ref:
        source = load_ref(args.ref)
        if not args.yes:
            confirm(source)
    else:
        source = load_npk(args.npk)
        if not args.yes:
            confirm(source)

    install(source)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, KeyError, ValueError, json.JSONDecodeError,
            subprocess.CalledProcessError) as error:
        print(f'Custom service install failed: {error}', file=sys.stderr)
        sys.exit(1)

"""Validation and Compose generation for NCC service descriptors.

An NCC service package is a signed metadata artifact: it names one container
image, the ports Caddy should expose it on, and the volumes it may keep. It
does not carry Compose text of its own. This module is the single place that
decides what a descriptor may say and turns it into the Compose fragment the
bundle includes.

Both the local package installer (`add-compose-service.py`) and the npack
publisher tooling (`npack-service.py`) use it, so a package cannot be built
with settings the installer would reject, and vice versa.
"""

import json
import re

SCHEMA = 1

ID_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
COMPOSE_NAME_RE = re.compile(r'^[a-z0-9][a-z0-9_-]*$')
ENV_NAME_RE = re.compile(r'^[A-Z_][A-Z0-9_]*$')
VOLUME_NAME_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')
# registry/name[:tag]@sha256:<64 hex>. A tag may be present alongside the
# digest; the digest is what pins the bytes.
IMAGE_RE = re.compile(
    r'^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[0-9a-f]{64}$')
DIGEST_RE = re.compile(r'^sha256:[0-9a-f]{64}$')

# Service IDs the bundle already owns, plus names that would collide with a
# Compose service or the sidecar's own records.
RESERVED_SERVICE_IDS = {
    'web', 'addr', 'admin', 'relay', 'npanel', 'ditto', 'search',
    'sidecar', 'manager', 'tor', 'caddy', 'opensearch', 'npack',
}

# Public TLS ports the bundle publishes. A custom service may not claim one.
PUBLIC_TLS_PORTS = {8443, 8444, 8445, 8446, 8447, 8448}

# Loopback ports used by bundle and panel plumbing. Caddy binds published
# ports on all interfaces, so a service may not claim one of these publicly
# either, even though the owning process listens on loopback only.
INTERNAL_PORTS = {
    3000, 3010, 3200, 3201, 3220, 3230, 8081, 9050, 9051, 9200, 13131,
    18045, 18046, 18047, 18048,
}

RESERVED_PUBLIC_PORTS = PUBLIC_TLS_PORTS | INTERNAL_PORTS | {8080}
RESERVED_BACKEND_PORTS = PUBLIC_TLS_PORTS | INTERNAL_PORTS | {8080}

MAX_ENV_ENTRIES = 64
MAX_ENV_VALUE = 4096
MAX_VOLUMES = 8
MAX_SUMMARY = 140
MAX_DESCRIPTION = 4000


class DescriptorError(ValueError):
    """A service descriptor is missing a field or asks for something unsafe."""


def _require_text(value, label, *, maximum=None, required=True):
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip():
        raise DescriptorError(f'{label} must be a non-empty string')
    text = value.strip()
    if maximum is not None and len(text) > maximum:
        raise DescriptorError(f'{label} must be at most {maximum} characters')
    if any(ord(char) < 32 and char not in '\n\t' for char in text):
        raise DescriptorError(f'{label} must not contain control characters')
    return text


def _require_port(value, label, reserved):
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 65535:
        raise DescriptorError(f'{label} must be a TCP port from 1 through 65535')
    if value in reserved:
        raise DescriptorError(f'{label} {value} is reserved by NCC Server')
    return value


def _require_path(value, label, *, allow_empty=False):
    if allow_empty and value == '':
        return ''
    if not isinstance(value, str) or not value.startswith('/'):
        raise DescriptorError(f'{label} must be an absolute URL path')
    if any(char in value for char in '\r\n"'):
        raise DescriptorError(f'{label} must not contain quotes or newlines')
    if '..' in value.split('/'):
        raise DescriptorError(f'{label} must not contain ".."')
    return value


def normalize_categories(spec):
    """Return a bounded, de-duplicated category list."""
    raw = spec.get('categories')
    if raw is None and spec.get('category') is not None:
        raw = [spec.get('category')]
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise DescriptorError('categories must be a list of strings')

    categories = []
    for entry in raw:
        value = _require_text(entry, 'category', maximum=32)
        if any(char.isspace() for char in value):
            raise DescriptorError('category must be a single word')
        key = value.casefold()
        if key not in {existing.casefold() for existing in categories}:
            categories.append(value)
    if len(categories) > 8:
        raise DescriptorError('categories may list at most 8 entries')
    return categories


def validate_descriptor(spec, *, require_digest=True):
    """Validate a service descriptor and return the normalised form.

    Unknown keys are rejected: a package that carries a setting this server
    does not understand is more likely to be a mistake or an attack than
    something worth ignoring.
    """
    if not isinstance(spec, dict):
        raise DescriptorError('service descriptor must be a JSON object')

    allowed = {
        'schema', 'service_id', 'name', 'summary', 'description', 'category',
        'categories', 'homepage', 'license', 'support_url', 'icon',
        'compose_service', 'image', 'public_port', 'backend_port',
        'container_port', 'probe_path', 'healthcheck_path', 'env', 'volumes',
        'min_bundle_version',
    }
    unknown = sorted(set(spec) - allowed)
    if unknown:
        raise DescriptorError(f'unknown service descriptor field(s): {", ".join(unknown)}')

    schema = spec.get('schema', SCHEMA)
    if schema != SCHEMA:
        raise DescriptorError(f'service descriptor schema must be {SCHEMA}')

    service_id = _require_text(spec.get('service_id'), 'service_id')
    if not ID_RE.fullmatch(service_id):
        raise DescriptorError('service_id must be lowercase letters, digits, and hyphens')
    if service_id in RESERVED_SERVICE_IDS:
        raise DescriptorError(f'{service_id} is reserved by NCC Server')

    name = _require_text(spec.get('name'), 'name', maximum=80)
    summary = _require_text(spec.get('summary'), 'summary', maximum=MAX_SUMMARY, required=False)
    description = _require_text(
        spec.get('description'), 'description', maximum=MAX_DESCRIPTION, required=False)
    homepage = _require_text(spec.get('homepage'), 'homepage', maximum=500, required=False)
    if homepage and not homepage.startswith(('https://', 'http://')):
        raise DescriptorError('homepage must be an http(s) URL')
    support_url = _require_text(spec.get('support_url'), 'support_url', maximum=500, required=False)
    if support_url and not support_url.startswith(('https://', 'http://')):
        raise DescriptorError('support_url must be an http(s) URL')
    license_name = _require_text(spec.get('license'), 'license', maximum=128, required=False)

    icon = _require_text(spec.get('icon'), 'icon', maximum=200, required=False)
    if icon:
        if icon.startswith('/') or '..' in icon.split('/') or '\\' in icon:
            raise DescriptorError('icon must be a package-relative path without ".."')

    compose_service = _require_text(spec.get('compose_service'), 'compose_service')
    if not COMPOSE_NAME_RE.fullmatch(compose_service):
        raise DescriptorError('compose_service must be a simple Compose service name')

    image = _require_text(spec.get('image'), 'image', maximum=300)
    if require_digest:
        if not IMAGE_RE.fullmatch(image):
            raise DescriptorError(
                'image must be pinned by digest (@sha256:<64 hex>), not a mutable tag')
    elif '@sha256:' in image and not IMAGE_RE.fullmatch(image):
        raise DescriptorError('image digest must be 64 lowercase hex characters')

    public_port = _require_port(spec.get('public_port'), 'public_port', RESERVED_PUBLIC_PORTS)
    backend_port = _require_port(spec.get('backend_port'), 'backend_port', RESERVED_BACKEND_PORTS)
    # 0 is allowed for "the image decides" only when the publisher knows the
    # backend is not published; keep it simple and require a real port.
    container_port = _require_port(spec.get('container_port'), 'container_port', set())
    if public_port == backend_port:
        raise DescriptorError('public_port and backend_port must be different')

    probe_path = _require_path(spec.get('probe_path', '/'), 'probe_path')
    healthcheck_path = _require_path(
        spec.get('healthcheck_path', probe_path), 'healthcheck_path')

    env = spec.get('env') or {}
    if not isinstance(env, dict) or len(env) > MAX_ENV_ENTRIES:
        raise DescriptorError(f'env must be an object with at most {MAX_ENV_ENTRIES} entries')
    env_out = {}
    for key, value in env.items():
        if not isinstance(key, str) or not ENV_NAME_RE.fullmatch(key):
            raise DescriptorError(f'env name {key!r} must match [A-Z_][A-Z0-9_]*')
        if not isinstance(value, str) or len(value) > MAX_ENV_VALUE or '\n' in value or '\r' in value:
            raise DescriptorError(f'env value for {key} must be a single-line string')
        env_out[key] = value

    volumes = spec.get('volumes') or {}
    if not isinstance(volumes, dict) or len(volumes) > MAX_VOLUMES:
        raise DescriptorError(f'volumes must be an object with at most {MAX_VOLUMES} entries')
    volumes_out = {}
    for key, value in volumes.items():
        if not isinstance(key, str) or not VOLUME_NAME_RE.fullmatch(key):
            raise DescriptorError(f'volume name {key!r} must match [a-zA-Z0-9][a-zA-Z0-9_.-]*')
        volumes_out[key] = _require_path(value, f'volume path for {key}')

    min_bundle_version = _require_text(
        spec.get('min_bundle_version'), 'min_bundle_version', maximum=40, required=False)

    return {
        'schema': SCHEMA,
        'service_id': service_id,
        'name': name,
        'summary': summary,
        'description': description,
        'categories': normalize_categories(spec),
        'homepage': homepage,
        'license': license_name,
        'support_url': support_url,
        'icon': icon,
        'compose_service': compose_service,
        'image': image,
        'public_port': public_port,
        'backend_port': backend_port,
        'container_port': container_port,
        'probe_path': probe_path,
        'healthcheck_path': healthcheck_path,
        'env': env_out,
        'volumes': volumes_out,
        'min_bundle_version': min_bundle_version,
    }


def _yaml_string(value):
    # JSON strings are valid YAML double-quoted scalars and escape control
    # characters, so a value can never break out of the generated document.
    return json.dumps(value, ensure_ascii=False)


def volume_key(service_id, name):
    """Compose volume key, namespaced so two services cannot share one."""
    return f'{service_id}-{name}'


def render_compose(spec):
    """Render the Compose fragment for a normalised descriptor.

    Every safety setting is written here rather than accepted from the
    package: no host networking, no extra capabilities, no bind mounts, a
    read-only root filesystem and a bounded tmpfs. Publishers choose only the
    image, environment, named volumes and the loopback port.
    """
    lines = [
        f'# Generated for NCC service {spec["service_id"]}.',
        '# Edit the service package, not this file: reinstalling regenerates it.',
        'services:',
        f'  {spec["compose_service"]}:',
        f'    image: {_yaml_string(spec["image"])}',
        f'    container_name: {_yaml_string("ncc-service-" + spec["service_id"])}',
        '    restart: unless-stopped',
        '    read_only: true',
        '    cap_drop:',
        '      - ALL',
        '    security_opt:',
        '      - no-new-privileges:true',
        '    pids_limit: 256',
        '    tmpfs:',
        '      - /tmp',
        '    ports:',
        f'      - "127.0.0.1:{spec["backend_port"]}:{spec["container_port"]}"',
    ]

    if spec['env']:
        lines.append('    environment:')
        for key, value in sorted(spec['env'].items()):
            lines.append(f'      {key}: {_yaml_string(value)}')

    if spec['volumes']:
        lines.append('    volumes:')
        for key, path in sorted(spec['volumes'].items()):
            lines.append(f'      - {_yaml_string(volume_key(spec["service_id"], key) + ":" + path)}')

    if spec['volumes']:
        lines.append('volumes:')
        for key in sorted(spec['volumes']):
            lines.append(f'  {volume_key(spec["service_id"], key)}:')

    return '\n'.join(lines) + '\n'


def npack_app_metadata(spec):
    """The `app` object npack publishes as its store listing."""
    app = {
        'summary': spec['summary'] or spec['name'],
        'categories': spec['categories'],
    }
    for key in ('description', 'homepage', 'license', 'support_url'):
        if spec[key]:
            app[key] = spec[key]
    if spec['icon']:
        app['icon'] = spec['icon']
    return app

#!/usr/bin/env python3
"""Create a new NCC service package from the working example app.

The generated package is an operator-authored Compose package. It can be
installed with `make service-add`, or built into a signed npack descriptor
with `npack-service.py`.
"""

import argparse
import json
import pathlib
import shutil
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from ncc_service_spec import (  # noqa: E402
    ID_RE,
    RESERVED_BACKEND_PORTS,
    RESERVED_PUBLIC_PORTS,
    RESERVED_SERVICE_IDS,
    DescriptorError,
    validate_descriptor,
)

PROJECT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = PROJECT / 'examples' / 'hello-service'


def fail(message):
    print(f'scaffold service: {message}', file=sys.stderr)
    sys.exit(1)


def title_for(service_id):
    return service_id.replace('-', ' ').title()


def replace_text(path, replacements):
    text = path.read_text()
    for old, new in replacements.items():
        text = text.replace(old, new)
    path.write_text(text)


def main():
    parser = argparse.ArgumentParser(
        description='Create a new NCC service package from examples/hello-service')
    parser.add_argument('--name', required=True,
                        help='service id, for example hello or my-app')
    parser.add_argument('--display-name',
                        help='display name shown in the panel (default: title-cased id)')
    parser.add_argument('--dir', help='target directory (default: ./<name>)')
    parser.add_argument('--image',
                        help='container image reference (default: ghcr.io/example/<name>:latest)')
    parser.add_argument('--public-port', type=int, default=8450)
    parser.add_argument('--backend-port', type=int, default=18080)
    parser.add_argument('--container-port', type=int, default=8080)
    parser.add_argument('--force', action='store_true',
                        help='write into an existing non-empty directory')
    args = parser.parse_args()

    service_id = args.name.strip()
    if not ID_RE.fullmatch(service_id):
        fail('service id must be lowercase letters, digits, and hyphens')
    if service_id in RESERVED_SERVICE_IDS:
        fail(f'{service_id} is reserved by NCC Server')
    if args.public_port in RESERVED_PUBLIC_PORTS:
        fail(f'public port {args.public_port} is reserved by NCC Server')
    if args.backend_port in RESERVED_BACKEND_PORTS:
        fail(f'backend port {args.backend_port} is reserved by NCC Server')
    if args.public_port == args.backend_port:
        fail('public and backend ports must be different')

    if not SOURCE.is_dir():
        fail(f'example app is missing: {SOURCE}')

    target = pathlib.Path(args.dir or service_id).expanduser().resolve()
    if target.exists() and not target.is_dir():
        fail(f'{target} exists and is not a directory')
    if target.exists() and any(target.iterdir()) and not args.force:
        fail(f'{target} is not empty; pass --force to write into it')

    display = args.display_name or title_for(service_id)
    compose_service = f'{service_id}-app'
    image = args.image or f'ghcr.io/example/{service_id}:latest'

    target.mkdir(parents=True, exist_ok=True)
    shutil.copytree(SOURCE, target, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('.git', '__pycache__'))

    spec_path = target / 'service.json'
    spec = json.loads(spec_path.read_text())
    spec.update({
        'service_id': service_id,
        'name': display,
        'summary': f'A {display} service on NCC',
        'description': (
            f'Replace this with what {display} does, who it is for, and '
            'anything an operator should know before installing it.'
        ),
        'categories': ['Social'],
        'compose_service': compose_service,
        'image': image,
        'public_port': args.public_port,
        'backend_port': args.backend_port,
        'container_port': args.container_port,
        'probe_path': '/healthz',
        'env': {
            'PORT': str(args.container_port),
            'GREETING': f'Hello from {display}',
        },
    })
    spec.pop('homepage', None)
    try:
        spec = validate_descriptor(spec, require_digest=False)
    except DescriptorError as error:
        fail(str(error))
    spec_path.write_text(json.dumps(spec, indent=2) + '\n')

    replace_text(target / 'compose.yaml', {
        'hello-app': compose_service,
        'GREETING: "Hello from NCC"': f'GREETING: "Hello from {display}"',
    })
    replace_text(target / 'README.md', {
        '# Hello Service': f'# {display}',
        'Hello Service': display,
        'hello-service': service_id,
    })
    replace_text(target / 'server.mjs', {
        'hello-service listening': f'{service_id} listening',
    })
    replace_text(target / 'icon.svg', {
        'Hello Service': display,
    })

    print(f'Created {target}')
    print(f'  service   {service_id} ({display})')
    print(f'  compose   {compose_service}')
    print(f'  image     {image}')
    print(f'  ports     public {args.public_port}, backend {args.backend_port}, container {args.container_port}')
    print()
    print('Next:')
    print(f'  make service-check PACKAGE={target}')
    print(f'  docker build -t {image} {target}')
    print(f'  sudo make service-add PACKAGE={target}')
    print('For a signed package, see docs/build-a-service.md.')


if __name__ == '__main__':
    main()

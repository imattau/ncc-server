#!/usr/bin/env python3
"""Validate an NCC service package without installing it.

This command is safe to run on a workstation. It does not need root, a running
sidecar, Docker, or an installed NCC node for local packages.
"""

import argparse
import importlib.util
import json
import pathlib
import re
import subprocess
import sys

SCRIPTS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

from ncc_service_spec import (  # noqa: E402
    DescriptorError,
    validate_descriptor,
)


def load_installer():
    spec = importlib.util.spec_from_file_location(
        'add_compose_service', SCRIPTS / 'add-compose-service.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_icon(package_dir, spec, errors):
    icon = spec.get('icon')
    if not icon:
        return
    if package_dir is None:
        return
    path = pathlib.Path(package_dir) / icon
    if not path.is_file():
        errors.append(f'icon {icon} does not exist in the package')
        return
    if path.stat().st_size > 256 * 1024:
        errors.append('icon must be at most 256 KiB')


def block_lines(text, key):
    """Return the indented lines under a top-level mapping key."""
    lines = text.splitlines()
    result = []
    in_block = False
    indent = 0
    for line in lines:
        if not in_block:
            match = re.match(rf'^(\s*){re.escape(key)}:\s*$', line)
            if match:
                indent = len(match.group(1))
                in_block = True
            continue
        if not line.strip():
            continue
        current = len(line) - len(line.lstrip())
        if current <= indent:
            in_block = False
            continue
        result.append(line)
    return result


def check_compose(compose, spec, errors, warnings, *, generated=False):
    compose_service = spec['compose_service']
    if not re.search(rf'^\s{{2,}}{re.escape(compose_service)}:\s*$', compose,
                     re.MULTILINE):
        errors.append(f'compose.yaml has no service named {compose_service!r}')

    expected = f'127.0.0.1:{spec["backend_port"]}:{spec["container_port"]}'
    template = ('127.0.0.1:${CUSTOM_SERVICE_BACKEND_PORT}:'
                '${CUSTOM_SERVICE_CONTAINER_PORT}')
    if expected not in compose and template not in compose:
        errors.append(
            'compose.yaml must map the backend with '
            f'127.0.0.1:{spec["backend_port"]}:{spec["container_port"]} '
            'or the CUSTOM_SERVICE_* template placeholders')

    body = '\n'.join(line for line in compose.splitlines()
                     if not line.lstrip().startswith('#'))

    forbidden = (
        (r'^\s*privileged:\s*true\s*$', 'privileged: true'),
        (r'^\s*network_mode:\s*["\']?host["\']?\s*$', 'network_mode: host'),
        (r'^\s*pid:\s*["\']?host["\']?\s*$', 'pid: host'),
        (r'^\s*ipc:\s*["\']?host["\']?\s*$', 'ipc: host'),
        (r'^\s*devices:\s*$', 'devices'),
        (r'^\s*cap_add:\s*$', 'cap_add'),
    )
    for pattern, label in forbidden:
        if re.search(pattern, body, re.MULTILINE):
            errors.append(f'compose.yaml must not use {label}')

    if '/var/run/docker.sock' in body:
        errors.append('compose.yaml must not mount the Docker socket')

    volume_lines = block_lines(body, 'volumes')
    for line in volume_lines:
        if re.match(r'^\s*-\s*["\']?(?:/|\.{1,2}/)', line) or \
                re.match(r'^\s*source:\s*["\']?(?:/|\.{1,2}/)', line):
            errors.append('compose.yaml must use named volumes, not host bind mounts')
            break

    if not re.search(r'^\s*read_only:\s*true\s*$', body, re.MULTILINE):
        warnings.append('compose.yaml does not set read_only: true')

    if not generated:
        user = re.search(r'^\s*user:\s*["\']?([^"\'\s]+)', body, re.MULTILINE)
        if not user:
            warnings.append('compose.yaml does not set user:; the image may run as root')
        elif user.group(1) in {'root', '0', '0:0'}:
            warnings.append('compose.yaml runs the container as root')

        if not re.search(r'^\s*healthcheck:\s*$', body, re.MULTILINE):
            warnings.append('compose.yaml has no healthcheck')

    if not re.search(r'^\s*tmpfs:\s*$', body, re.MULTILINE):
        warnings.append('compose.yaml has no tmpfs mount; the image must not need writable scratch space')


def check_online(spec, errors, warnings):
    image = spec['image']
    try:
        result = subprocess.run(
            ['docker', 'buildx', 'imagetools', 'inspect', image],
            text=True, capture_output=True)
    except FileNotFoundError:
        warnings.append('docker is not installed; skipped the registry check')
        return
    if result.returncode != 0:
        warnings.append(
            f'could not inspect {image} in the registry: '
            f'{(result.stderr or result.stdout).strip()[:300]}')


def main():
    parser = argparse.ArgumentParser(
        description='Validate an NCC service package without installing it')
    parser.add_argument('--package', help='local package directory')
    parser.add_argument('--npk', help='local .npk descriptor')
    parser.add_argument('--ref', help='signed npack reference')
    parser.add_argument('--signed', action='store_true',
                        help='require a digest-pinned image and signed package rules')
    parser.add_argument('--online', action='store_true',
                        help='ask the registry whether the image exists')
    parser.add_argument('--print-compose', action='store_true',
                        help='print the Compose fragment that would be used')
    parser.add_argument('--json', action='store_true', help='machine-readable output')
    args = parser.parse_args()

    sources = [bool(args.package), bool(args.npk), bool(args.ref)]
    if sum(sources) != 1:
        parser.error('pass exactly one of --package, --npk, or --ref')

    errors = []
    warnings = []
    spec = None
    compose = None
    package_dir = None
    provenance = None

    try:
        installer = load_installer()
        if args.package:
            source = installer.load_local_package(args.package)
            package_dir = source['package_dir']
        elif args.npk:
            source = installer.load_npk(args.npk)
        else:
            source = installer.load_ref(args.ref)
        spec = source['spec']
        compose = source['compose']
        provenance = source.get('provenance')

        if args.signed:
            try:
                spec = validate_descriptor(spec, require_digest=True)
            except DescriptorError as error:
                errors.append(str(error))
        check_icon(package_dir, spec, errors)
        check_compose(compose, spec, errors, warnings,
                      generated=source.get("package_dir") is None)
        if args.online:
            check_online(spec, errors, warnings)
    except Exception as error:
        errors.append(str(error))

    result = {
        'ok': not errors,
        'service': spec.get('service_id') if spec else None,
        'name': spec.get('name') if spec else None,
        'image': spec.get('image') if spec else None,
        'categories': spec.get('categories') if spec else [],
        'signed': bool(provenance and provenance.get('verified')),
        'warnings': warnings,
        'errors': errors,
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if spec:
            print(f"Checked {spec['service_id']} ({spec['name']})")
            print(f"  image   {spec['image']}")
            print(f"  ports   public {spec['public_port']}, backend {spec['backend_port']}, container {spec['container_port']}")
            print(f"  compose {spec['compose_service']}")
        for warning in warnings:
            print(f'  warning {warning}')
        for error in errors:
            print(f'  error   {error}')
        print('OK' if not errors else 'FAILED')
        if args.print_compose and compose:
            print()
            print(compose.rstrip())

    sys.exit(0 if not errors else 1)


if __name__ == '__main__':
    main()

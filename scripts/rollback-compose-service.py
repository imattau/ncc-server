#!/usr/bin/env python3
"""Restore the package saved by the last `make service-upgrade`."""

import importlib.util
import os
import pathlib
import sys
import time

SCRIPTS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))


def load_installer():
    spec = importlib.util.spec_from_file_location(
        'add_compose_service', SCRIPTS / 'add-compose-service.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if len(sys.argv) != 2:
        print('Usage: rollback-compose-service.py SERVICE_ID', file=sys.stderr)
        sys.exit(2)
    service_id = sys.argv[1].strip()
    installer = load_installer()

    protected = {'web', 'addr', 'admin', 'relay', 'npanel', 'ditto',
                 'search', 'manager'}
    if service_id in protected:
        print(f'{service_id} is a node service and cannot be rolled back with this command',
              file=sys.stderr)
        sys.exit(1)

    if os.geteuid() != 0:
        print('run this command as root on the NCC-Server host', file=sys.stderr)
        sys.exit(1)

    target = installer.PROJECT / 'custom-services' / 'packages' / service_id
    previous = installer.previous_package(target)
    if not previous.is_dir():
        print(f'no previous package for {service_id} at {previous}', file=sys.stderr)
        sys.exit(1)

    failed = (target.parent / '.failed' /
              f'{service_id}-{time.strftime("%Y%m%dT%H%M%SZ")}')
    failed.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.rename(failed)
    previous.rename(target)

    source = installer.load_local_package(target)
    source['package_dir'] = None  # already staged with concrete compose values
    npack = installer.read_metadata(target / 'npack.json')
    if npack:
        source['provenance'] = npack
        source['signed'] = True

    print(f'Restoring {service_id} from {target}')
    if failed.exists():
        print(f'  previous current package: {failed}')
    installer.install(source, upgrade=False)
    print(f'Rolled back {service_id}.')


if __name__ == '__main__':
    main()

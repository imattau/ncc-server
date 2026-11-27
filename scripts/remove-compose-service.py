#!/usr/bin/env python3
"""Remove an installed custom NCC service.

Stops and removes its container, Caddy route, sidecar record and staged
package. Named volumes are kept unless --purge is passed.
"""

import argparse
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
    parser = argparse.ArgumentParser(description='Remove an installed NCC service')
    parser.add_argument('--service', required=True, help='NCC service id')
    parser.add_argument('--purge', action='store_true',
                        help='also delete the staged package and named volumes')
    parser.add_argument('--yes', action='store_true',
                        help='skip the confirmation prompt')
    args = parser.parse_args()

    if os.geteuid() != 0:
        print('run this command as root on the NCC-Server host', file=sys.stderr)
        sys.exit(1)

    installer = load_installer()
    service_id = args.service.strip()
    protected = {'web', 'addr', 'admin', 'relay', 'npanel', 'ditto',
                 'search', 'manager'}
    if service_id in protected:
        print(f'{service_id} is a node service and cannot be removed with this command',
              file=sys.stderr)
        sys.exit(1)
    target = installer.PROJECT / 'custom-services' / 'packages' / service_id
    route = installer.PROJECT / 'custom-services' / 'caddy' / f'{service_id}.caddy'
    spec = installer.read_metadata(target / 'service.json')
    compose_services = []
    if spec.get('compose_service'):
        compose_services.append(spec['compose_service'])

    record = None
    try:
        existing = installer.api('/api/services')
        record = next((item for item in existing
                       if item.get('service_id') == service_id), None)
    except RuntimeError as error:
        print(f'warning: could not read sidecar services: {error}', file=sys.stderr)
        existing = []

    if not target.exists() and not record:
        print(f'{service_id} is not installed', file=sys.stderr)
        sys.exit(1)

    config = (record or {}).get('config') or {}
    for name in config.get('compose_services') or []:
        if name not in compose_services:
            compose_services.append(name)
    state = (record or {}).get('state') or {}
    onion = state.get('last_onion_address') or config.get('onion_address')

    if not args.yes:
        if not sys.stdin.isatty():
            print('refusing to remove without a terminal; pass --yes to confirm',
                  file=sys.stderr)
            sys.exit(1)
        print(f"Remove {service_id}" + (f" ({spec.get('name')})" if spec.get('name') else ''))
        print(f"  container {', '.join(compose_services) or '(unknown)'}")
        print(f"  onion     {onion or '(none recorded)'}")
        print(f"  data      {'delete volumes and package' if args.purge else 'keep volumes'}")
        answer = input('Continue? [y/N] ').strip().lower()
        if answer not in {'y', 'yes'}:
            print('removal cancelled')
            return

    if onion:
        control = config.get('tor_control') or {}
        password = control.get('password')
        if control.get('enabled') and password:
            try:
                installer.tor_control.remove_onion(password, onion)
                print(f'Removed onion {onion}')
            except Exception as error:
                print(f'warning: could not remove onion {onion}: {error}',
                      file=sys.stderr)
        else:
            print(f'warning: onion {onion} has no enabled control password; '
                  'restart Tor to drop it', file=sys.stderr)

    if route.exists():
        route.unlink()
    try:
        installer.run([str(installer.PROJECT / 'scripts' / 'compose-bundle.sh'),
                       'exec', '-T', 'caddy', 'caddy', 'reload',
                       '--config', '/etc/caddy/Caddyfile',
                       '--adapter', 'caddyfile'])
    except Exception as error:
        print(f'warning: could not reload Caddy: {error}', file=sys.stderr)

    if compose_services:
        command = ['rm', '-s', '-f']
        if args.purge:
            command.append('-v')
        installer.run([str(installer.PROJECT / 'scripts' / 'compose-bundle.sh'),
                       *command, *compose_services])

    if args.purge:
        for key in spec.get('volumes') or {}:
            for name in (f'{service_id}-{key}', key,
                         f'ncc-bundle_{key}', f'ncc-bundle_{service_id}-{key}'):
                installer.subprocess.run(
                    ['docker', 'volume', 'rm', name],
                    check=False, capture_output=True)

    if record:
        installer.api(f'/api/service/{record["id"]}', 'DELETE')
        print(f'Deleted sidecar record {record["id"]}')

    if target.exists():
        if args.purge:
            installer.shutil.rmtree(target)
            print(f'Deleted {target}')
        else:
            removed = (target.parent / '.removed' /
                       f'{service_id}-{time.strftime("%Y%m%dT%H%M%SZ")}')
            removed.parent.mkdir(parents=True, exist_ok=True)
            target.rename(removed)
            print(f'Moved package to {removed}')

    print(f'Removed {service_id}. The last published locator remains until its TTL expires.')


if __name__ == '__main__':
    main()

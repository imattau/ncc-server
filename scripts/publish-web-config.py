#!/usr/bin/env python3
"""Publish the public root npub for the welcome page."""

import argparse
import json
import os
import pathlib
import re
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--identity-file', default='/etc/ncc-server/operator-identity.json')
    parser.add_argument('--output', default='/srv/ncc-server/public/ncc-config.json')
    parser.add_argument('--group-id', type=int, default=996)
    args = parser.parse_args()

    identity = json.loads(pathlib.Path(args.identity_file).read_text())
    npub = identity.get('npub')
    if not isinstance(npub, str) or not re.fullmatch(r'npub1[023456789acdefghjklmnpqrstuvwxyz]{20,}', npub):
        raise SystemExit('operator identity has no valid public npub')

    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.ncc-config-', dir=output.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump({'npub': npub}, stream)
            stream.write('\n')
        os.chmod(temporary, 0o644)
        os.chown(temporary, 0, args.group_id)
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == '__main__':
    main()

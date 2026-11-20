#!/usr/bin/env python3
"""Write the installed NCC Server release information.

The admin panel's Server Upgrade button needs two facts that are not visible
from a running container: which release tag the host checkout is on, and which
GitHub repository updates should come from. This script records them in a
small root-owned JSON file. The node-agent reads the file (read-only) and the
sidecar compares the tag with the latest GitHub release.

The installer calls this on every fresh install and the upgrade runner calls
it again after checking out a release, so the file always describes the code
that is actually on disk.
"""

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

SEMVER = re.compile(r'^v?(\d+)\.(\d+)\.(\d+)$')
ORIGIN_PATTERNS = (
    re.compile(
        r'^https?://(?:[^@/]+@)?github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?/?$',
        re.IGNORECASE,
    ),
    re.compile(
        r'^ssh://git@github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?/?$',
        re.IGNORECASE,
    ),
    re.compile(
        r'^git@github\.com:(?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?$',
        re.IGNORECASE,
    ),
)


def parse_origin(value):
    """Return `{owner, repo}` for a GitHub remote URL, or None.

    Forks matter: the upgrade check must follow the repository this checkout
    actually came from, not a hard-coded upstream.
    """
    if not isinstance(value, str):
        return None
    for pattern in ORIGIN_PATTERNS:
        match = pattern.match(value.strip())
        if match:
            owner = match.group('owner').strip()
            repo = match.group('repo').strip()
            if owner and repo:
                return {'owner': owner, 'repo': repo}
    return None


def version_from_tag(tag):
    if not isinstance(tag, str):
        return None
    match = SEMVER.match(tag.strip())
    if not match:
        return None
    return '.'.join(match.groups())


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def git_output(project, *args):
    return subprocess.run(
        ['git', '-C', str(project), *args],
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()


def release_tag(project, explicit=None):
    """The release tag the checkout is on, or None for a branch/detached commit."""
    if explicit:
        return explicit.strip()
    tags = [
        line.strip()
        for line in git_output(project, 'tag', '--points-at', 'HEAD').splitlines()
        if SEMVER.match(line.strip())
    ]
    if not tags:
        return None
    return sorted(tags, key=lambda value: tuple(int(part) for part in SEMVER.match(value).groups()))[-1]


def release_info(project, tag=None, commit=None, origin=None):
    project = pathlib.Path(project)
    resolved_tag = release_tag(project, tag)
    resolved_commit = commit or git_output(project, 'rev-parse', 'HEAD')
    if origin:
        resolved_origin = origin
    else:
        try:
            resolved_origin = git_output(project, 'remote', 'get-url', 'origin')
        except subprocess.CalledProcessError:
            resolved_origin = None
    return {
        'schema': 1,
        'version': version_from_tag(resolved_tag),
        'tag': resolved_tag,
        'commit': resolved_commit,
        'origin': resolved_origin,
        'installedAt': utc_now(),
    }


def atomic_write(path, payload, mode=0o644):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        if os.geteuid() == 0:
            os.chown(temporary, 0, 0)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-dir', default=str(pathlib.Path(__file__).resolve().parents[1]))
    parser.add_argument('--output', default='/var/lib/ncc-server-release/release.json')
    parser.add_argument('--tag', default=None, help='release tag to record, for example v0.2.13')
    parser.add_argument('--commit', default=None)
    parser.add_argument('--origin', default=None)
    parser.add_argument('--quiet', action='store_true')
    args = parser.parse_args()

    try:
        payload = release_info(args.project_dir, args.tag, args.commit, args.origin)
    except (OSError, subprocess.CalledProcessError) as error:
        print(f'Could not describe the server checkout: {error}', file=sys.stderr)
        return 1

    atomic_write(args.output, payload)
    if not args.quiet:
        print(f"Recorded NCC Server {payload['version'] or 'unreleased'} at {args.output}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

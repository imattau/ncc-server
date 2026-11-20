#!/usr/bin/env python3
"""Run a full NCC Server Docker Compose upgrade.

This is the root-side half of the admin panel's Server Upgrade button. The
node-agent writes a small request file when an administrator starts an
upgrade; a systemd path unit runs this script, which:

  1. checks out the requested release tag from the configured origin;
  2. pins the bundle's own upstream images in .env to that release;
  3. runs the same install-compose-host.sh the manual installer update uses;
  4. reconciles per-service Tor endpoints (non-fatal);
  5. records the installed release for the panel's next version check.

It also works manually (`--manual --target v0.2.13`) for the first install
that has no upgrade helper yet. A status file is written after every step so
the panel can follow the run and recover after the sidecar restarts.

The script is intentionally self-contained: the launcher copies it (and the
release helper next to it) to /run before checkout, so a release cannot
change the code that is already executing.
"""

import argparse
import fcntl
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import tempfile
import traceback
from datetime import datetime, timezone

TARGET_RE = re.compile(r'^v?(\d+)\.(\d+)\.(\d+)$')
IMAGE_VARS = {
    'TOR_IMAGE': 'tor',
    'SIDECAR_IMAGE': 'sidecar',
    'RELAY_IMAGE': 'relay',
    'NPANEL_IMAGE': 'npanel',
    'DITTO_WEB_IMAGE': 'ditto-web',
    'SEARCH_IMAGE': 'search',
    'SEARCH_UI_IMAGE': 'search-ui',
    'NPACK_IMAGE': 'npack',
    'CADDY_IMAGE': 'caddy',
}
UPSTREAM = 'ghcr.io/imattau/ncc-server-'
STEPS = (
    ('prepare', 'Preparing the upgrade'),
    ('checkout', 'Checking out the release'),
    ('pin', 'Pinning bundle images'),
    ('install', 'Pulling and recreating containers'),
    ('tor', 'Reconciling Tor endpoints'),
    ('release', 'Writing release information'),
)
STATUS_SCHEMA = 1
MAX_LOG_LINES = 20
MAX_LOG_LINE = 500
ANSI_ESCAPE = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')


class UpgradeError(RuntimeError):
    """A step failed in a way the panel should show verbatim."""


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def now_ms():
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def validate_target(value):
    """Normalise `0.2.13` / `v0.2.13` and reject anything else."""
    if not isinstance(value, str):
        raise UpgradeError('The upgrade target is missing')
    match = TARGET_RE.match(value.strip())
    if not match:
        raise UpgradeError(f'Invalid upgrade target: {value!r}')
    return 'v' + '.'.join(match.groups())


def atomic_write(path, text, mode=0o644):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        if os.geteuid() == 0:
            os.chown(temporary, 0, 0)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path):
    try:
        with open(path, 'r') as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def write_status(path, payload):
    atomic_write(path, json.dumps(payload, indent=2, sort_keys=True) + '\n', 0o644)


def git(project, *args, check=True):
    return subprocess.run(
        ['git', '-C', str(project), *args],
        check=check,
        text=True,
        capture_output=True,
    )


def tracked_changes(project):
    """Tracked changes that a release checkout would destroy.

    public/ is generated and is refreshed by the installer; an operator who
    built it on the host should not block an upgrade. Everything else is
    treated as operator work and aborts instead of being overwritten.
    """
    result = git(project, 'status', '--porcelain', '--untracked-files=no', check=False)
    if result.returncode != 0:
        raise UpgradeError((result.stderr or result.stdout).strip() or 'Could not inspect the server checkout')
    changes = []
    for line in result.stdout.splitlines():
        path = line[3:].strip()
        if ' -> ' in path:
            path = path.split(' -> ', 1)[1]
        if not path or path.startswith('public/'):
            continue
        changes.append(path)
    return changes


def fetch_tag(project, tag):
    """Fetch one tag, or accept it when the checkout already has it locally."""
    result = git(
        project,
        'fetch', '--depth', '1', '--force', 'origin',
        f'refs/tags/{tag}:refs/tags/{tag}',
        check=False,
    )
    if result.returncode != 0:
        local = git(project, 'rev-parse', '--verify', f'refs/tags/{tag}^{{commit}}', check=False)
        if local.returncode != 0:
            detail = (result.stderr or result.stdout).strip()
            raise UpgradeError(
                f'Could not fetch {tag} from origin'
                + (f': {detail.splitlines()[-1]}' if detail else '')
            )


def pin_value(name, current, version):
    """Return a pinned image reference, or None to leave the value alone."""
    value = current.strip()
    quote = ''
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        quote = value[0]
        value = value[1:-1]
    if '@sha256:' in value or '@sha512:' in value:
        return None
    if not value.startswith(UPSTREAM):
        return None
    colon = value.rfind(':')
    slash = value.rfind('/')
    if colon <= slash:
        return None
    repo = value[:colon]
    if not re.match(r'^' + re.escape(UPSTREAM) + r'[a-z0-9-]+$', repo):
        return None
    pinned = f'{repo}:{version}'
    return f'{quote}{pinned}{quote}' if quote else pinned


def plan_env_pins(lines, version):
    """Pin upstream bundle images without touching custom registries.

    A pin is only changed when the value is one of this project's published
    images. Custom registries, digest pins and unrelated values are reported
    as skipped and left exactly as they were.
    """
    output = []
    updated = []
    skipped = []
    seen = set()
    for line in lines:
        match = re.match(r'^(\s*)(#\s*)?([A-Z0-9_]+)=(.*)$', line)
        if not match or match.group(3) not in IMAGE_VARS:
            output.append(line)
            continue
        indent, comment, name, value = match.groups()
        if comment:
            # The optional Caddy image is shipped commented out so Compose
            # falls back to :latest. Pin it so the panel assets and Caddyfile
            # move together with the rest of the release. A commented custom
            # value is still the operator's choice; leave it alone.
            if name == 'CADDY_IMAGE':
                pinned = pin_value(name, value, version)
                if pinned is None and value.strip():
                    skipped.append(name)
                    seen.add(name)
                    output.append(line)
                else:
                    value_out = pinned or f'{UPSTREAM}{IMAGE_VARS[name]}:{version}'
                    output.append(f'{indent}{name}={value_out}')
                    updated.append(name)
                    seen.add(name)
            else:
                output.append(line)
            continue
        if not value.strip():
            pinned = f'{UPSTREAM}{IMAGE_VARS[name]}:{version}'
        else:
            pinned = pin_value(name, value, version)
        if pinned is None:
            skipped.append(name)
            seen.add(name)
            output.append(line)
            continue
        output.append(f'{indent}{name}={pinned}')
        updated.append(name)
        seen.add(name)

    for name, image in IMAGE_VARS.items():
        if name in seen:
            continue
        output.append(f'{name}={UPSTREAM}{image}:{version}')
        updated.append(name)
    return output, updated, skipped


def backup_env(path, directory):
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = pathlib.Path(directory) / f'{path.name}.bak-{stamp}'
    backup.parent.mkdir(parents=True, exist_ok=True)
    data = path.read_bytes()
    fd, temporary = tempfile.mkstemp(prefix=f'.{backup.name}.', dir=backup.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        if os.geteuid() == 0:
            os.chown(temporary, 0, 0)
        os.replace(temporary, backup)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return backup


def log_tail(path):
    try:
        lines = pathlib.Path(path).read_text(errors='replace').splitlines()
    except OSError:
        return []
    return [ANSI_ESCAPE.sub('', line)[:MAX_LOG_LINE] for line in lines[-MAX_LOG_LINES:]]


def run_command(project, args, log_path, env=None):
    log_path = pathlib.Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, 'a', encoding='utf-8', errors='replace') as log:
        log.write(f'\n=== {utc_now()} :: {" ".join(str(arg) for arg in args)}\n')
        log.flush()
        completed = subprocess.run(
            [str(arg) for arg in args],
            cwd=str(project),
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
        )
    return completed.returncode


def status_base(job_id, target, previous, started_at, dry_run):
    return {
        'schema': STATUS_SCHEMA,
        'jobId': job_id,
        'state': 'running',
        'step': 'prepare',
        'stepIndex': 1,
        'totalSteps': len(STEPS),
        'steps': [{'id': step, 'label': label} for step, label in STEPS],
        'target': target,
        'from': previous,
        'startedAt': started_at,
        'finishedAt': None,
        'error': None,
        'warning': None,
        'logTail': [],
        'pins': {'updated': [], 'skipped': []},
        'dryRun': bool(dry_run),
    }


def release_info(path):
    value = read_json(path) or {}
    return {
        'tag': value.get('tag') if isinstance(value.get('tag'), str) else None,
        'version': value.get('version') if isinstance(value.get('version'), str) else None,
    }


def read_request(path):
    value = read_json(path)
    if not value:
        raise UpgradeError(f'No upgrade request was found at {path}')
    if not isinstance(value.get('target'), str):
        raise UpgradeError('The upgrade request has no target')
    job_id = value.get('jobId')
    if not isinstance(job_id, str) or not re.match(r'^[A-Za-z0-9_-]{4,128}$', job_id):
        raise UpgradeError('The upgrade request has no valid job id')
    return value


def run(args):
    project = pathlib.Path(args.project_dir).resolve()
    status_path = pathlib.Path(args.status)
    release_path = pathlib.Path(args.release_file)
    log_path = pathlib.Path(args.log_file)
    lock_path = pathlib.Path(args.lock_file)

    def terminate(signum, _frame):
        raise UpgradeError(f'Upgrade terminated by signal {signum}')

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text('')
    except OSError:
        pass
    lock = open(lock_path, 'a+')
    try:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print('Another NCC Server upgrade is already running.', file=sys.stderr)
            return 1

        request = None
        if args.manual:
            if not args.target:
                raise UpgradeError('--manual needs --target vX.Y.Z')
            request = {'target': args.target, 'jobId': f'manual-{now_ms()}'}
        else:
            request = read_request(args.request)
            try:
                pathlib.Path(args.request).unlink()
            except OSError:
                pass

        target = validate_target(args.target or request.get('target'))
        previous = release_info(release_path)
        status = status_base(
            request.get('jobId'),
            target,
            previous.get('tag') or previous.get('version'),
            now_ms(),
            args.dry_run,
        )
        write_status(status_path, status)

        def step(step_id):
            index = next((i for i, (sid, _) in enumerate(STEPS, start=1) if sid == step_id), 1)
            status['step'] = step_id
            status['stepIndex'] = index
            status['logTail'] = log_tail(log_path) if log_path.exists() else []
            write_status(status_path, status)

        step('prepare')
        if not (project / '.env').is_file():
            raise UpgradeError(f'{project / ".env"} is missing; run install-compose-host first')
        if not (project / 'scripts' / 'install-compose-host.sh').is_file():
            raise UpgradeError(f'{project}/scripts/install-compose-host.sh is missing')

        step('checkout')
        fetch_tag(project, target)
        changes = tracked_changes(project)
        if changes:
            shown = ', '.join(changes[:5])
            more = f' (+{len(changes) - 5} more)' if len(changes) > 5 else ''
            raise UpgradeError(
                'The server checkout has local changes; commit or discard them on the host: '
                f'{shown}{more}'
            )
        if not args.dry_run:
            checkout = git(project, 'checkout', '--detach', '--force', target, check=False)
            if checkout.returncode != 0:
                raise UpgradeError((checkout.stderr or checkout.stdout).strip() or f'Could not check out {target}')

        step('pin')
        env_path = project / '.env'
        lines = env_path.read_text().splitlines()
        pinned, updated, skipped = plan_env_pins(lines, target.lstrip('v'))
        status['pins'] = {'updated': updated, 'skipped': skipped}
        if not args.dry_run:
            backup_env(env_path, status_path.parent / 'env-backups')
            atomic_write(env_path, '\n'.join(pinned) + '\n', 0o600)
        write_status(status_path, status)

        if args.dry_run:
            status['state'] = 'success'
            status['finishedAt'] = now_ms()
            status['logTail'] = log_tail(log_path) if log_path.exists() else []
            write_status(status_path, status)
            print(f'Dry run: would upgrade to {target} (updated {len(updated)} image pins)')
            return 0

        step('install')
        env = dict(os.environ)
        env.setdefault('DEBIAN_FRONTEND', 'noninteractive')
        env['NCC_SKIP_PREFLIGHT'] = '1'
        env['NCC_SKIP_NAT_CHECK'] = '1'
        env['NCC_UPGRADE_STATE_DIR'] = str(status_path.parent)
        env['NCC_RELEASE_DIR'] = str(release_path.parent)
        env['NCC_SKIP_RELEASE_FILE'] = '1'
        code = run_command(project, ['bash', project / 'scripts' / 'install-compose-host.sh'], log_path, env)
        if code != 0:
            raise UpgradeError(f'install-compose-host.sh exited with code {code}')

        step('tor')
        tor_script = project / 'scripts' / 'enable-compose-tor.py'
        if tor_script.is_file():
            code = run_command(project, [sys.executable, tor_script], log_path, env)
            if code != 0:
                status['warning'] = f'Tor reconcile exited with code {code}'
                write_status(status_path, status)
        else:
            status['warning'] = 'enable-compose-tor.py is not present in this release'
            write_status(status_path, status)

        step('release')
        release_script = pathlib.Path(__file__).resolve().with_name('publish-server-release.py')
        if release_script.is_file():
            code = run_command(
                project,
                [sys.executable, release_script, '--project-dir', project,
                 '--output', release_path, '--tag', target],
                log_path,
                env,
            )
            if code != 0:
                status['warning'] = f'Release information was not written (exit {code})'
                write_status(status_path, status)
        else:
            status['warning'] = 'publish-server-release.py was not found next to the upgrade runner'
            write_status(status_path, status)

        status['state'] = 'success'
        status['finishedAt'] = now_ms()
        status['logTail'] = log_tail(log_path)
        write_status(status_path, status)
        print(f'NCC Server upgraded to {target}')
        return 0
    except Exception as error:  # noqa: BLE001 - every failure belongs in the status file
        traceback.print_exc()
        try:
            status = locals().get('status')
            if not isinstance(status, dict):
                request = locals().get('request') or {}
                status = status_base(
                    request.get('jobId', f'manual-{now_ms()}'),
                    str(request.get('target') or args.target or 'unknown'),
                    None,
                    now_ms(),
                    args.dry_run,
                )
            status['state'] = 'failed'
            status['error'] = str(error) or error.__class__.__name__
            status['finishedAt'] = now_ms()
            status['logTail'] = log_tail(pathlib.Path(args.log_file))
            write_status(pathlib.Path(args.status), status)
        except Exception:
            traceback.print_exc()
        return 1
    finally:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        finally:
            lock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-dir', default=str(pathlib.Path(__file__).resolve().parents[1]))
    parser.add_argument('--target', default=None, help='release tag, for example v0.2.13')
    parser.add_argument('--manual', action='store_true', help='run without a request file')
    parser.add_argument('--dry-run', action='store_true', help='validate and plan without changing the host')
    parser.add_argument('--request', default='/var/lib/ncc-server-upgrade/request.json')
    parser.add_argument('--status', default='/var/lib/ncc-server-upgrade/status.json')
    parser.add_argument('--release-file', default='/var/lib/ncc-server-release/release.json')
    parser.add_argument('--log-file', default='/var/lib/ncc-server-upgrade/upgrade.log')
    parser.add_argument('--lock-file', default='/run/lock/ncc-server-upgrade.lock')
    return run(parser.parse_args())


if __name__ == '__main__':
    raise SystemExit(main())

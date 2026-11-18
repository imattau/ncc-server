"""Locate or create the Tor control password the sidecar uses.

The Compose bundle runs one password-authenticated Tor control port. Every
service's onion is created through that same control connection, so a new
service must inherit the node's control password instead of inventing one.
"""

import os
import pathlib
import re
import secrets
import socket
import subprocess
import time

CONTROL_HOST = '127.0.0.1'
CONTROL_PORT = 9051


def _local_password(service):
    control = (service.get('config') or {}).get('tor_control') or {}
    password = control.get('password')
    if not control.get('enabled') or not isinstance(password, str) or not password:
        return None
    if str(control.get('host', '127.0.0.1')) not in {'127.0.0.1', 'localhost'}:
        return None
    if str(control.get('port', CONTROL_PORT)) != str(CONTROL_PORT):
        return None
    return password


def existing_password(services):
    """The node's Tor control password, taken from web when possible."""
    for service in services:
        if service.get('service_id') == 'web':
            password = _local_password(service)
            if password:
                return password
    for service in services:
        password = _local_password(service)
        if password:
            return password
    return None


def password_updates(services, password):
    """Services whose stored Tor control password must change.

    Restarting Tor with a new control password drops every onion service.
    Callers update these records before republishing so services created by a
    previous run (including custom services) re-add their onions too.
    """
    for service in services:
        control = (service.get('config') or {}).get('tor_control') or {}
        if not control.get('enabled') or control.get('password') == password:
            continue
        # Do not rewrite a service that points at a different Tor instance.
        if str(control.get('host', '127.0.0.1')) not in {'127.0.0.1', 'localhost'}:
            continue
        if str(control.get('port', CONTROL_PORT)) != str(CONTROL_PORT):
            continue
        yield service, control


def _quote(value):
    return value.replace('\\', '\\\\').replace('"', '\\"')


def authenticate(password, *, host=CONTROL_HOST, port=CONTROL_PORT, timeout=3):
    """Whether Tor accepts this control password right now."""
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            sock.sendall(f'AUTHENTICATE "{_quote(password)}"\r\n'.encode())
            reply = sock.recv(1024)
        return reply.startswith(b'250')
    except OSError:
        return False


def wait_for_control(*, host=CONTROL_HOST, port=CONTROL_PORT, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=2):
                return
        except OSError:
            time.sleep(1)
    raise RuntimeError(f'Tor control port {host}:{port} did not become ready')


def _compose(project):
    return [str(project / 'scripts' / 'compose-bundle.sh')]


def _hash_password(project, password):
    result = subprocess.run(
        _compose(project) + ['exec', '-T', 'tor', 'tor', '--hash-password', password],
        check=True, capture_output=True, text=True,
    )
    return next((line.strip() for line in result.stdout.splitlines()
                 if re.fullmatch(r'16:[A-F0-9]{58}', line.strip())), None)


def _write_torrc(torrc_path, hashed):
    torrc_path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    torrc_path.write_text('\n'.join((
        f'SocksPort {CONTROL_HOST}:9050',
        f'ControlPort {CONTROL_HOST}:{CONTROL_PORT}',
        'CookieAuthentication 0',
        f'HashedControlPassword {hashed}',
        '',
    )))
    os.chown(torrc_path, 0, 0)
    os.chmod(torrc_path, 0o644)


def configure(project, torrc_path, services):
    """Return a usable control password, reusing the stored one when possible."""
    project = pathlib.Path(project)
    stored = existing_password(services)
    if stored and authenticate(stored):
        return stored

    password = secrets.token_urlsafe(48)
    hashed = _hash_password(project, password)
    if not hashed:
        raise RuntimeError('Tor did not return a valid HashedControlPassword')
    _write_torrc(pathlib.Path(torrc_path), hashed)
    subprocess.run(_compose(project) + ['restart', 'tor'], check=True,
                   stdout=subprocess.DEVNULL)
    wait_for_control()
    if not authenticate(password):
        raise RuntimeError('Tor rejected the new control password')
    return password

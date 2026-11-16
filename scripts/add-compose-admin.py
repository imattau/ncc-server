#!/usr/bin/env python3
"""Grant an npub Npanel admin access and invite it to manage the sidecar."""
import json
import os
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request


PROJECT = pathlib.Path(__file__).resolve().parents[1]
SIDECAR_API = os.environ.get('SIDECAR_ADMIN_URL', 'http://127.0.0.1:3000').rstrip('/')
SIDECAR_UI = 'http://127.0.0.1:3000'
BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'


def fail(message):
    raise RuntimeError(message)


def decode_npub(npub):
    if not npub or npub.lower() != npub or '1' not in npub:
        fail('NPUB must be a lowercase npub1... value.')
    separator = npub.rfind('1')
    if npub[:separator] != 'npub' or separator < 1:
        fail('NPUB must be an npub1... value.')
    try:
        data = [BECH32.index(char) for char in npub[separator + 1:]]
    except ValueError:
        fail('NPUB contains characters outside the Bech32 alphabet.')
    if len(data) < 7:
        fail('NPUB is too short to contain a key and checksum.')

    def polymod(values):
        generators = (0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)
        checksum = 1
        for value in values:
            top = checksum >> 25
            checksum = ((checksum & 0x1ffffff) << 5) ^ value
            for index, generator in enumerate(generators):
                if (top >> index) & 1:
                    checksum ^= generator
        return checksum

    hrp = npub[:separator]
    expanded_hrp = [ord(char) >> 5 for char in hrp] + [0] + [ord(char) & 31 for char in hrp]
    if polymod(expanded_hrp + data) != 1:
        fail('NPUB has an invalid Bech32 checksum.')

    payload = data[:-6]
    output = bytearray()
    accumulator = bits = 0
    for value in payload:
        accumulator = (accumulator << 5) | value
        bits += 5
        while bits >= 8:
            bits -= 8
            output.append((accumulator >> bits) & 0xff)
    if bits >= 5 or ((accumulator << (8 - bits)) & 0xff):
        fail('NPUB contains invalid Bech32 padding.')
    if len(output) != 32:
        fail('NPUB must encode a 32-byte public key.')
    return output.hex()


def sidecar_request(path, method='GET', payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        SIDECAR_API + path,
        data=body,
        method=method,
        headers={'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors='replace').strip()
        fail(f'sidecar API {path} returned HTTP {error.code}: {detail or error.reason}')
    except urllib.error.URLError as error:
        fail(f'cannot reach the sidecar at {SIDECAR_API}: {error.reason}')


def compose_command():
    if subprocess.run(['docker', 'compose', 'version'], cwd=PROJECT,
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        return ['docker', 'compose', '-p', 'ncc-bundle', '-f', str(PROJECT / 'compose.yaml')]
    return ['docker-compose', '-p', 'ncc-bundle', '-f', str(PROJECT / 'compose.yaml')]


def main():
    if os.geteuid() != 0:
        fail('run through make bundle-add-admin (which uses sudo) or as root')
    if len(sys.argv) != 2:
        fail('usage: make bundle-add-admin NPUB=npub1...')

    npub = sys.argv[1]
    pubkey = decode_npub(npub)

    status = sidecar_request('/api/setup/status')
    if not status.get('initialized'):
        fail('the sidecar has not been initialized yet')
    admins = sidecar_request('/api/admins')
    existing = next((admin for admin in admins if admin.get('pubkey') == pubkey), None)

    compose = compose_command()
    result = subprocess.run(
        compose + ['exec', '-T', 'npanel', 'npanel', '--config',
                   '/tmp/npanel.toml', 'make-admin', npub],
        cwd=PROJECT, capture_output=True, text=True,
    )
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        fail('Npanel admin provisioning failed: ' + (detail[-500:] or 'no error details'))
    print(f'Granted Npanel admin access to {npub}.')

    if existing and existing.get('status') in ('active', 'pending'):
        print(f'Sidecar access already exists (status: {existing["status"]}); no duplicate invite sent.')
    else:
        sidecar_request('/api/admin/invite', 'POST', {
            'npub': npub,
            'publicUrl': SIDECAR_UI,
        })
        print(f'Sent a sidecar admin invitation to {npub}; it will appear as pending until accepted.')

    print('Ditto Relay: no additional-admin setting is exposed by this Compose bundle; its operator key remains the relay identity.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'Admin provisioning failed: {error}', file=sys.stderr)
        sys.exit(1)

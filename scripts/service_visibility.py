#!/usr/bin/env python3
"""Manage per-service visibility and private locator recipients.

NCC-05 locators are public by default. A private service publishes its NCC-02
anchor without an endpoint and its NCC-05 locator NIP-44-encrypted to the
recipient keys. This script is the CLI half of that switch; the admin panel's
Installed page calls the same sidecar setting through a NIP-98 route.

The operator key is always a recipient, so the node can open its own service.
Node admins are included by default; pass --no-admins to opt out.

Private is unlisting, not access control. The service port is still open and
anyone who learns the endpoint can reach it; use the service's own login or a
firewall when the content itself must be protected.
"""

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request


PROJECT = pathlib.Path(__file__).resolve().parents[1]
ENV_PATH = pathlib.Path(os.environ.get('NCC_PROJECT_ENV', PROJECT / '.env'))
IDENTITY_PATH = pathlib.Path(os.environ.get(
    'NCC_IDENTITY_FILE', '/etc/ncc-server/operator-identity.json'))
API = os.environ.get('SIDECAR_ADMIN_URL', 'http://127.0.0.1:3000').rstrip('/')

CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
HEX_PATTERN = 64


def fail(message):
    raise RuntimeError(message)


def _polymod(values):
    generators = (0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)
    checksum = 1
    for value in values:
        top = checksum >> 25
        checksum = ((checksum & 0x1ffffff) << 5) ^ value
        for index, generator in enumerate(generators):
            if (top >> index) & 1:
                checksum ^= generator
    return checksum


def _hrp_expand(hrp):
    return [ord(char) >> 5 for char in hrp] + [0] + [ord(char) & 31 for char in hrp]


def _create_checksum(hrp, data):
    values = _hrp_expand(hrp) + data
    polymod = _polymod(values + [0, 0, 0, 0, 0, 0]) ^ 1
    return [(polymod >> (5 * (5 - index))) & 31 for index in range(6)]


def _bech32_encode(hrp, data):
    combined = data + _create_checksum(hrp, data)
    return hrp + '1' + ''.join(CHARSET[value] for value in combined)


def _convertbits(data, frombits, tobits, pad=True):
    accumulator = 0
    bits = 0
    output = []
    max_value = (1 << tobits) - 1
    for value in data:
        accumulator = (accumulator << frombits) | value
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            output.append((accumulator >> bits) & max_value)
    if pad:
        if bits:
            output.append((accumulator << (tobits - bits)) & max_value)
    elif bits >= frombits or ((accumulator << (tobits - bits)) & max_value):
        fail('bech32 payload has invalid padding')
    return output


def decode_npub(npub):
    """Decode a lowercase npub into a 32-byte hex public key."""
    if not isinstance(npub, str):
        fail('NPUB must be a string')
    if not npub or npub.lower() != npub or '1' not in npub:
        fail('NPUB must be a lowercase npub1... value.')
    separator = npub.rfind('1')
    if npub[:separator] != 'npub' or separator < 1:
        fail('NPUB must be an npub1... value.')
    try:
        data = [CHARSET.index(char) for char in npub[separator + 1:]]
    except ValueError:
        fail('NPUB contains characters outside the Bech32 alphabet.')
    if len(data) < 7:
        fail('NPUB is too short to contain a key and checksum.')
    if _polymod(_hrp_expand('npub') + data) != 1:
        fail('NPUB has an invalid Bech32 checksum.')
    output = bytes(_convertbits(data[:-6], 5, 8, pad=False))
    if len(output) != 32:
        fail('NPUB must encode a 32-byte public key.')
    return output.hex()


def encode_npub(hex_pubkey):
    """Encode a 32-byte hex public key as npub."""
    if not isinstance(hex_pubkey, str) or len(hex_pubkey) != HEX_PATTERN:
        fail('public key must be 64 hexadecimal characters')
    try:
        raw = bytes.fromhex(hex_pubkey)
    except ValueError:
        fail('public key must be hexadecimal')
    return _bech32_encode('npub', _convertbits(raw, 8, 5))


def parse_pubkey(value):
    """Accept npub or 64-character hex and return lowercase hex."""
    if not isinstance(value, str):
        fail('recipient must be an npub or 64-character hex public key')
    trimmed = value.strip()
    if len(trimmed) == HEX_PATTERN:
        try:
            int(trimmed, 16)
        except ValueError:
            fail(f'not a valid hex public key: {trimmed}')
        return trimmed.lower()
    return decode_npub(trimmed)


def split_values(values):
    """Flatten repeated, comma-separated and whitespace-separated arguments."""
    out = []
    for value in values or []:
        if value is None:
            continue
        for part in str(value).replace(',', ' ').split():
            if part:
                out.append(part)
    return out


def normalize_recipients(values):
    """Return unique recipient hex keys in input order."""
    seen = set()
    out = []
    for value in split_values(values):
        key = parse_pubkey(value)
        if key not in seen:
            seen.add(key)
            out.append(key)
    return out


def read_env(path=ENV_PATH):
    values = {}
    try:
        text = pathlib.Path(path).read_text()
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        values[key.strip()] = value.strip().strip('"\'')
    return values


def operator_pubkey(env=None):
    """Find the operator public key from the environment or identity file."""
    env = env or {}
    for value in (os.environ.get('NCC_OPERATOR_PUBKEY'), env.get('NCC_OPERATOR_PUBKEY')):
        if value:
            try:
                return parse_pubkey(value)
            except RuntimeError:
                pass
    try:
        identity = json.loads(pathlib.Path(IDENTITY_PATH).read_text())
    except (OSError, ValueError):
        return None
    for key in ('pubkey', 'npub'):
        value = identity.get(key)
        if value:
            try:
                return parse_pubkey(value)
            except RuntimeError:
                continue
    return None


def request(path, method='GET', data=None, timeout=60):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(
        API + path, data=body, method=method,
        headers={'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors='replace').strip()
        fail(f'sidecar API {path} returned HTTP {error.code}: {detail or error.reason}')
    except urllib.error.URLError as error:
        fail(f'cannot reach the sidecar at {API}: {error.reason}')


def service_records():
    services = request('/api/services')
    return [item for item in services if item.get('type') != 'sidecar']


def admin_pubkeys():
    try:
        admins = request('/api/admins')
    except RuntimeError:
        return []
    return [parse_pubkey(item.get('pubkey') or item.get('npub'))
            for item in admins if item.get('pubkey') or item.get('npub')]


def resolve_recipients(explicit, *, operator=None, admins=(), include_admins=True):
    """Build the final recipient set: explicit, operator, then admins."""
    ordered = list(normalize_recipients(explicit))
    seen = set(ordered)
    for value in ([operator] if operator else []) + (list(admins) if include_admins else []):
        if value and value not in seen:
            seen.add(value)
            ordered.append(value)
    return ordered


def recipients_for(config):
    values = config.get('ncc05_recipients') if isinstance(config, dict) else None
    if not isinstance(values, list):
        return []
    out = []
    for value in values:
        try:
            out.append(parse_pubkey(value))
        except RuntimeError:
            continue
    return out


def visibility(config):
    return 'private' if (config or {}).get('service_mode') == 'private' else 'public'


def set_visibility(config, mode, recipients):
    """Return a merged config with a single visibility update."""
    updated = dict(config or {})
    updated['service_mode'] = mode
    updated['ncc05_recipients'] = list(recipients)
    return updated


def choose_targets(services, requested):
    if not requested or 'all' in requested:
        return services
    by_id = {item.get('service_id'): item for item in services}
    missing = [service_id for service_id in requested if service_id not in by_id]
    if missing:
        fail('no active NCC service with ID: ' + ', '.join(missing))
    return [by_id[service_id] for service_id in requested]


def print_list(services):
    rows = []
    for service in sorted(services, key=lambda item: item.get('service_id') or ''):
        config = service.get('config') or {}
        recipients = [encode_npub(value) for value in recipients_for(config)]
        npub = service.get('npub')
        address = f"ncc://{npub}/{service.get('service_id')}/" if npub else '-'
        rows.append((
            service.get('service_id') or '?',
            address,
            'dedicated' if config.get('service_identity') == 'dedicated' else 'shared',
            visibility(config),
            ', '.join(recipients) if recipients else '-',
        ))
    widths = [max(len(row[index]) for row in rows + [('SERVICE', 'ADDRESS', 'KEY', 'MODE', 'RECIPIENTS')])
              for index in range(5)]
    header = ('SERVICE', 'ADDRESS', 'KEY', 'MODE', 'RECIPIENTS')
    print('  '.join(value.ljust(widths[index]) for index, value in enumerate(header)))
    for row in rows:
        print('  '.join(value.ljust(widths[index]) for index, value in enumerate(row)))


def run_set(args):
    if os.geteuid() != 0:
        fail('run through make service-private/service-public, or as root')
    services = service_records()
    targets = choose_targets(services, args.service)
    if args.new_identity:
        if len(targets) != 1:
            fail('--new-identity can only be used for one service at a time')
        if targets[0].get('service_id') == 'addr':
            fail('the root addr service must keep the operator identity')
    operator = operator_pubkey(read_env())
    admins = admin_pubkeys()
    explicit = normalize_recipients(args.recipients)

    final_recipients = resolve_recipients(
        explicit,
        operator=operator,
        admins=admins,
        include_admins=not args.no_admins,
    )
    if args.mode == 'private' and not final_recipients:
        fail('private mode needs at least one recipient; the operator key could not be determined')

    plans = []
    for service in targets:
        config = set_visibility(service.get('config') or {}, args.mode, final_recipients)
        plans.append((service, config))

    if args.dry_run:
        print('Dry run; no sidecar records will change.')
        for service, config in plans:
            suffix = ' with a new npub' if args.new_identity else ''
            print(f"{service.get('service_id')}: {args.mode}"
                  f" ({len(recipients_for(config))} recipient(s)){suffix}")
        return

    if args.new_identity:
        service, config = plans[0]
        result = request(f'/api/service/{service["id"]}/identity', 'POST', {
            'config': config,
            'retireOld': not args.no_retire,
        }, timeout=600)
        if not result.get('success'):
            fail(result.get('error') or 'identity rotation failed')
        print(f"Created {result.get('npub')} for {service.get('service_id')}.")
        print(f"NCC address: {result.get('address')}")
        return

    for service, config in plans:
        request(f'/api/service/{service["id"]}', 'PUT', {'config': config})
        print(f"Set {service.get('service_id')} to {args.mode} service.")

    if args.no_republish:
        print('Skipped republish; run make service-list after the next sidecar publish cycle.')
        return

    result = request('/api/services/republish', 'POST', {}, timeout=600)
    details = {str(item.get('serviceId')): item for item in result.get('details', [])}
    failures = []
    for service, _config in plans:
        detail = details.get(str(service.get('id')))
        if not detail or not detail.get('success'):
            failures.append(f"{service.get('service_id')}: "
                            f"{(detail or {}).get('error', 'no success response')}")
    if failures:
        fail('locator republish failed: ' + '; '.join(failures))
    print(f"Republished {len(plans)} service record(s).")


def run_rekey(args):
    if os.geteuid() != 0:
        fail('run through make service-rekey, or as root')
    service = choose_targets(service_records(), [args.service])[0]
    if service.get('service_id') == 'addr':
        fail('the root addr service must keep the operator identity')
    if args.dry_run:
        print(f"Would create a new npub for {service.get('service_id')} "
              f"(retire old: {not args.no_retire}).")
        return
    result = request(f'/api/service/{service["id"]}/identity', 'POST', {
        'retireOld': not args.no_retire,
    }, timeout=600)
    if not result.get('success'):
        fail(result.get('error') or 'identity rotation failed')
    print(f"Created {result.get('npub')} for {service.get('service_id')}.")
    print(f"Previous npub: {result.get('previousNpub') or '-'}")
    print(f"NCC address: {result.get('address')}")
    if result.get('retired') is False:
        print('Warning: old records were not retired; they remain until their normal expiry.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest='action', required=True)

    subparsers.add_parser('list', help='show each service visibility and recipients')

    set_parser = subparsers.add_parser('set', help='change visibility for one or more services')
    set_parser.add_argument('--service', action='append', default=[],
                            help='service ID, repeated; use all for every service')
    set_parser.add_argument('--mode', choices=('public', 'private'), required=True)
    set_parser.add_argument('--recipients', action='append', default=[],
                            help='npub or hex keys, comma- or space-separated; repeated')
    set_parser.add_argument('--no-admins', action='store_true',
                            help='do not include node admin keys as recipients')
    set_parser.add_argument('--new-identity', action='store_true',
                            help='create a new npub for the service and retire its old address')
    set_parser.add_argument('--no-retire', action='store_true',
                            help='with --new-identity, leave the old records until their expiry')
    set_parser.add_argument('--dry-run', action='store_true')
    set_parser.add_argument('--no-republish', action='store_true')

    rekey_parser = subparsers.add_parser('rekey', help='give one service a new npub')
    rekey_parser.add_argument('--service', required=True, help='service ID')
    rekey_parser.add_argument('--no-retire', action='store_true')
    rekey_parser.add_argument('--dry-run', action='store_true')

    args = parser.parse_args(argv)
    if args.action == 'list':
        print_list(service_records())
        return 0
    if args.action == 'rekey':
        run_rekey(args)
        return 0
    run_set(args)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(f'Service visibility failed: {error}', file=sys.stderr)
        raise SystemExit(1)

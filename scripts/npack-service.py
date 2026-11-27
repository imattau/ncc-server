#!/usr/bin/env python3
"""Build and publish an NCC service as a signed npack artifact.

The container image build and upload are unchanged: this tool only turns the
already-published image reference into a signed `.npk` service descriptor and
publishes it to Nostr relays and a Blossom server.

Usage:

    # Pin the image digest and build hello-1.0.0.npk
    npack-service.py build --service-dir ./hello --version 1.0.0 \
        --publisher npub1... --output ./hello-1.0.0.npk

    # Publish the artifact and its kind:9900 release event
    npack-service.py publish --manifest ./hello-1.0.0.manifest.json \
        --secret-key "$NOSTR_SECRET_KEY" \
        --relay wss://relay.damus.io --server https://blossom.primal.net

`build` requires the `npack` CLI (it owns .npk packing and manifest
validation). `publish` is a thin wrapper around `npack publish` so a CI job
does not need to remember the flags.
"""

import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from ncc_service_spec import (  # noqa: E402
    DescriptorError,
    validate_descriptor,
    render_compose,
    npack_app_metadata,
)

KIND = 'ncc-service'
PACKAGE_ROOT = pathlib.Path('share/ncc-server/services')
SEMVER_RE = re.compile(r'^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')
PUBLISHER_RE = re.compile(r'^(?:npub1[0-9a-z]{20,}|[0-9a-f]{64})$', re.IGNORECASE)
DIGEST_RE = re.compile(r'^sha256:[0-9a-f]{64}$')


def fail(message):
    print(f'npack service: {message}', file=sys.stderr)
    sys.exit(1)


def run(args, *, capture=False):
    try:
        return subprocess.run(
            args, check=True, text=True, capture_output=capture)
    except FileNotFoundError:
        fail(f'{args[0]} is not installed; install npack from '
             'https://github.com/imattau/npack releases')
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or error.stdout or '').strip()
        fail(f'{args[0]} failed: {detail or error.returncode}')


def split_image_reference(reference):
    """Return (repository, tag or None, digest or None)."""
    digest = None
    if '@' in reference:
        reference, digest = reference.split('@', 1)

    tag = None
    slash = reference.rfind('/')
    colon = reference.rfind(':')
    if colon > slash:
        reference, tag = reference[:colon], reference[colon + 1:]
    return reference, tag, digest


def resolve_digest(image):
    """Resolve an image tag to its registry digest, without rebuilding it."""
    repository, _tag, _digest = split_image_reference(image)

    try:
        buildx = subprocess.run(
            ['docker', 'buildx', 'imagetools', 'inspect', image,
             '--format', '{{.Manifest.Digest}}'],
            text=True, capture_output=True,
        )
    except FileNotFoundError:
        fail('docker is required to resolve an image tag; '
             'pass --image with @sha256:... or push the image first')
    if buildx.returncode == 0:
        digest = (buildx.stdout or '').strip().strip('"')
        if DIGEST_RE.fullmatch(digest):
            return digest

    # Fall back to the local image's repo digest, which a normal `docker
    # build` + `docker push` records and needs no network access.
    local = subprocess.run(
        ['docker', 'image', 'inspect', image, '--format',
         '{{range .RepoDigests}}{{println .}}{{end}}'],
        text=True, capture_output=True,
    )
    if local.returncode == 0:
        for entry in (local.stdout or '').split():
            if '@' in entry:
                repo, digest = entry.split('@', 1)
                if repo == repository and DIGEST_RE.fullmatch(digest):
                    return digest

    fail(f'could not resolve {image} to a sha256 digest; '
         'push the image or pass --image with @sha256:...')


def pin_image(image):
    repository, _tag, digest = split_image_reference(image)
    if digest:
        if not DIGEST_RE.fullmatch(digest):
            fail('image digest must be 64 lowercase hex characters')
        return f'{repository}@{digest}'
    return f'{repository}@{resolve_digest(image)}'


def read_service(service_dir):
    manifest = service_dir / 'service.json'
    if not manifest.is_file():
        fail(f'{manifest} does not exist')
    try:
        spec = json.loads(manifest.read_text())
    except json.JSONDecodeError as error:
        fail(f'{manifest} is not valid JSON: {error}')
    return spec


def copy_payload(service_dir, root, spec, *, readme):
    """Write the package payload and return the package-relative icon path."""
    target = root / PACKAGE_ROOT / spec['service_id']
    target.mkdir(parents=True, exist_ok=True)
    (target / 'service.json').write_text(
        json.dumps(spec, indent=2, sort_keys=True) + '\n')
    (target / 'compose.yaml').write_text(render_compose(spec))

    icon_package = None
    if spec.get('icon'):
        source = (service_dir / spec['icon']).resolve()
        if service_dir not in source.parents or not source.is_file():
            fail(f'icon {spec["icon"]} must be a file inside {service_dir}')
        if source.stat().st_size > 256 * 1024:
            fail('icon must be at most 256 KiB')
        shutil.copyfile(source, target / source.name)
        icon_package = (PACKAGE_ROOT / spec['service_id'] / source.name).as_posix()

    if readme.is_file():
        shutil.copyfile(readme, target / 'README.md')
    return icon_package


def write_manifest(root, spec, *, version, publisher, artifact, os_name, arch,
                   repo, commit, icon_package):
    app = npack_app_metadata(spec)
    if icon_package:
        app['icon'] = icon_package
    else:
        app.pop('icon', None)

    manifest = {
        'publisher': publisher,
        'name': spec['service_id'],
        'version': version,
        'artifact': artifact,
        'sha256': '',
        'os': os_name,
        'arch': arch,
        'format': 'npk',
        'kind': KIND,
        'dependencies': [],
        'conflicts': [],
        'runtime_requires': [],
        'provides': [f'{KIND}/{spec["service_id"]}'],
        'post_install': [],
        'app': app,
    }
    if repo:
        manifest['repo'] = repo
    if commit:
        manifest['commit'] = commit

    metadata = root / '.npack'
    metadata.mkdir(parents=True, exist_ok=True)
    (metadata / 'manifest.json').write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    return manifest


def build(args):
    service_dir = pathlib.Path(args.service_dir).resolve()
    spec = read_service(service_dir)

    if args.image:
        spec['image'] = args.image
    spec['image'] = pin_image(spec['image'])

    try:
        spec = validate_descriptor(spec)
    except DescriptorError as error:
        fail(str(error))

    if not SEMVER_RE.fullmatch(args.version):
        fail(f'{args.version} is not a Semantic Version (for example 1.2.0)')
    if not PUBLISHER_RE.fullmatch(args.publisher):
        fail('publisher must be an npub or 64-character hex public key')

    output = pathlib.Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    root = pathlib.Path(tempfile.mkdtemp(prefix='ncc-service-npk-'))
    try:
        icon_package = copy_payload(
            service_dir, root, spec, readme=service_dir / 'README.md')
        write_manifest(
            root, spec, version=args.version, publisher=args.publisher,
            artifact=output.name, os_name=args.os, arch=args.arch,
            repo=args.repo, commit=args.commit, icon_package=icon_package,
        )
        run([args.npack, 'pack', str(root), '--output', str(output)])
    finally:
        shutil.rmtree(root, ignore_errors=True)

    external = output.with_name(output.stem + '.manifest.json')
    run([args.npack, 'manifest', str(output), '--output', str(external)])
    published = json.loads(external.read_text())

    print(f'Built {output}')
    print(f'Manifest {external}')
    print(f'  kind     {KIND}')
    print(f'  package  {args.publisher}/{spec["service_id"]} {args.version}')
    print(f'  image    {spec["image"]}')
    print(f'  sha256   {published.get("sha256", "")}')
    print('Publish it with:')
    print(f'  {pathlib.Path(sys.argv[0]).name} publish --manifest {external} \\')
    print('    --secret-key "$NOSTR_SECRET_KEY" \\')
    print('    --relay wss://relay.damus.io --server https://blossom.primal.net')


def publish(args):
    manifest = pathlib.Path(args.manifest).resolve()
    if not manifest.is_file():
        fail(f'{manifest} does not exist')

    command = [args.npack, 'publish', str(manifest)]
    for relay in args.relay:
        command += ['--relay', relay]
    for server in args.server:
        command += ['--server', server]
    for url in args.artifact_url:
        command += ['--artifact-url', url]
    if args.icon_url:
        command += ['--icon-url', args.icon_url]
    if args.secret_key:
        command += ['--secret-key', args.secret_key]

    result = run(command, capture=True)
    if result.stdout:
        print(result.stdout.rstrip())
    if result.stderr:
        print(result.stderr.rstrip(), file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(
        description='Build and publish NCC service descriptors as npack artifacts')
    parser.add_argument('--npack', default='npack', help='path to the npack CLI')
    sub = parser.add_subparsers(dest='command', required=True)

    build_parser = sub.add_parser('build', help='pin the image and build an .npk')
    build_parser.add_argument('--service-dir', required=True,
                              help='directory containing service.json')
    build_parser.add_argument('--version', required=True, help='package SemVer')
    build_parser.add_argument('--publisher', required=True,
                              help='publisher npub or 64-character hex key')
    build_parser.add_argument('--output', required=True, help='output .npk path')
    build_parser.add_argument('--image', help='image reference to pin (overrides service.json)')
    build_parser.add_argument('--os', default='linux')
    build_parser.add_argument('--arch', default='x86_64',
                              help='target architecture, or any for multi-arch images')
    build_parser.add_argument('--repo', help='NIP-34 repository address (30617:pubkey:id)')
    build_parser.add_argument('--commit', help='source commit')
    build_parser.set_defaults(func=build)

    publish_parser = sub.add_parser('publish', help='publish a built manifest')
    publish_parser.add_argument('--manifest', required=True)
    publish_parser.add_argument('--secret-key',
                                help='publisher private key (defaults to the npack registered key)')
    publish_parser.add_argument('--relay', action='append', default=[],
                                help='relay URL, repeatable')
    publish_parser.add_argument('--server', action='append', default=[],
                                help='Blossom server URL, repeatable')
    publish_parser.add_argument('--artifact-url', action='append', default=[],
                                help='extra artifact download URL, repeatable')
    publish_parser.add_argument('--icon-url', help='already-hosted icon URL')
    publish_parser.set_defaults(func=publish)

    args = parser.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()

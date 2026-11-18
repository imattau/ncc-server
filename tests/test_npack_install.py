import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = pathlib.Path(__file__).parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

SPEC = importlib.util.spec_from_file_location(
    'add_compose_service', SCRIPTS / 'add-compose-service.py')
INSTALL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALL)

DIGEST = 'sha256:' + 'b' * 64


def build_npk(root, *, kind='ncc-service', publisher='npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', spec=None):
    service = root / 'share' / 'ncc-server' / 'services' / 'hello'
    service.mkdir(parents=True)
    (root / '.npack').mkdir()
    (root / '.npack' / 'manifest.json').write_text(json.dumps({
        'publisher': publisher,
        'name': 'hello',
        'version': '1.0.0',
        'kind': kind,
    }))
    (service / 'service.json').write_text(json.dumps(spec or {
        'schema': 1,
        'service_id': 'hello',
        'name': 'Hello Service',
        'compose_service': 'app',
        'image': f'ghcr.io/acme/hello@{DIGEST}',
        'public_port': 8450,
        'backend_port': 18080,
        'container_port': 80,
        'probe_path': '/',
    }))
    (service / 'README.md').write_text('Hello.\n')

    npk = root.parent / 'hello-1.0.0.npk'
    subprocess.run(['tar', '--zstd', '-cf', str(npk), '-C', str(root), '.'],
                   check=True, capture_output=True)
    return npk


class LocalNpkTests(unittest.TestCase):
    def test_reads_a_descriptor_and_generates_safe_compose(self):
        with tempfile.TemporaryDirectory() as work:
            root = pathlib.Path(work) / 'root'
            npk = build_npk(root)

            source = INSTALL.load_npk(npk)

        self.assertEqual(source['spec']['service_id'], 'hello')
        self.assertEqual(source['provenance']['version'], '1.0.0')
        self.assertFalse(source['provenance']['verified'])
        self.assertEqual(source['readme'], 'Hello.\n')
        self.assertIn('read_only: true', source['compose'])
        self.assertIn('127.0.0.1:18080:80', source['compose'])

    def test_rejects_a_package_with_the_wrong_kind(self):
        with tempfile.TemporaryDirectory() as work:
            root = pathlib.Path(work) / 'root'
            npk = build_npk(root, kind='package')
            with self.assertRaisesRegex(RuntimeError, 'ncc-service'):
                INSTALL.load_npk(npk)

    def test_rejects_a_descriptor_without_a_digest(self):
        with tempfile.TemporaryDirectory() as work:
            root = pathlib.Path(work) / 'root'
            npk = build_npk(root, spec={
                'schema': 1,
                'service_id': 'hello',
                'name': 'Hello Service',
                'compose_service': 'app',
                'image': 'ghcr.io/acme/hello:latest',
                'public_port': 8450,
                'backend_port': 18080,
                'container_port': 80,
            })
            with self.assertRaisesRegex(RuntimeError, 'pinned by digest'):
                INSTALL.load_npk(npk)


if __name__ == '__main__':
    unittest.main()

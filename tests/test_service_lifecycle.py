import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).parents[1]
SCRIPTS = ROOT / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from ncc_service_spec import validate_descriptor  # noqa: E402


def load_installer():
    spec = importlib.util.spec_from_file_location(
        'add_compose_service', SCRIPTS / 'add-compose-service.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SPEC = {
    'schema': 1,
    'service_id': 'hello',
    'name': 'Hello Service',
    'compose_service': 'hello-app',
    'image': 'ghcr.io/acme/hello:latest',
    'public_port': 8450,
    'backend_port': 18080,
    'container_port': 8080,
    'probe_path': '/healthz',
}


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.work.name)
        self.installer = load_installer()
        self.installer.PROJECT = self.root
        self.target = self.root / 'custom-services' / 'packages' / 'hello'

        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'service.json').write_text(
            json.dumps(validate_descriptor(SPEC, require_digest=False), indent=2))
        (self.source / 'compose.yaml').write_text(
            'services:\n'
            '  hello-app:\n'
            '    image: ${CUSTOM_SERVICE_IMAGE}\n'
            '    ports:\n'
            '      - "127.0.0.1:${CUSTOM_SERVICE_BACKEND_PORT}:${CUSTOM_SERVICE_CONTAINER_PORT}"\n')
        (self.source / 'README.md').write_text('old\n')

    def tearDown(self):
        self.work.cleanup()

    def source_dict(self):
        return self.installer.load_local_package(self.source)

    def test_first_install_copies_the_package(self):
        self.installer.stage_files(self.source_dict(), self.target)
        self.assertTrue((self.target / 'service.json').is_file())
        self.assertEqual((self.target / 'README.md').read_text(), 'old\n')

    def test_local_compose_edits_are_refreshed_without_a_version_bump(self):
        self.installer.stage_files(self.source_dict(), self.target)
        (self.source / 'README.md').write_text('new\n')
        self.installer.stage_files(self.source_dict(), self.target)
        self.assertEqual((self.target / 'README.md').read_text(), 'new\n')

    def test_changed_descriptor_requires_upgrade(self):
        self.installer.stage_files(self.source_dict(), self.target)
        changed = dict(SPEC)
        changed['name'] = 'Changed Service'
        (self.source / 'service.json').write_text(
            json.dumps(validate_descriptor(changed, require_digest=False), indent=2))
        with self.assertRaisesRegex(RuntimeError, '--upgrade'):
            self.installer.stage_files(self.source_dict(), self.target)

    def test_upgrade_rotates_the_previous_package(self):
        self.installer.stage_files(self.source_dict(), self.target)
        changed = dict(SPEC)
        changed['name'] = 'Changed Service'
        (self.source / 'service.json').write_text(
            json.dumps(validate_descriptor(changed, require_digest=False), indent=2))
        self.installer.stage_files(self.source_dict(), self.target, upgrade=True)

        previous = self.target.parent / '.previous' / 'hello'
        self.assertTrue((previous / 'service.json').is_file())
        self.assertEqual(
            json.loads((previous / 'service.json').read_text())['name'],
            'Hello Service')
        self.assertEqual(
            json.loads((self.target / 'service.json').read_text())['name'],
            'Changed Service')


if __name__ == '__main__':
    unittest.main()

import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

import ncc_service_spec as spec_module  # noqa: E402


class TemplateTests(unittest.TestCase):
    def test_local_template_validates_and_uses_a_runnable_image(self):
        path = ROOT / 'templates' / 'custom-compose-service' / 'service.json'
        spec = json.loads(path.read_text())
        normalized = spec_module.validate_descriptor(spec, require_digest=False)

        self.assertEqual(normalized['compose_service'], 'hello-app')
        self.assertEqual(normalized['container_port'], 8080)
        self.assertIn('nginx-unprivileged', normalized['image'])

        compose = (path.parent / 'compose.yaml').read_text()
        self.assertIn('  hello-app:', compose)
        self.assertIn('127.0.0.1:${CUSTOM_SERVICE_BACKEND_PORT}:${CUSTOM_SERVICE_CONTAINER_PORT}', compose)
        self.assertIn('read_only: true', compose)
        self.assertIn('tmpfs:', compose)
        self.assertIn('user:', compose)

    def test_npack_template_uses_a_valid_pinned_example(self):
        path = ROOT / 'templates' / 'ncc-service-npk' / 'service.json'
        spec = json.loads(path.read_text())
        spec['image'] = 'ghcr.io/example/hello@sha256:' + 'a' * 64
        normalized = spec_module.validate_descriptor(spec, require_digest=True)

        self.assertEqual(normalized['compose_service'], 'hello-app')
        self.assertEqual(normalized['container_port'], 8080)

    def test_example_app_validates(self):
        path = ROOT / 'examples' / 'hello-service' / 'service.json'
        normalized = spec_module.validate_descriptor(
            json.loads(path.read_text()), require_digest=False)
        self.assertEqual(normalized['service_id'], 'hello')
        self.assertEqual(normalized['probe_path'], '/healthz')


if __name__ == '__main__':
    unittest.main()

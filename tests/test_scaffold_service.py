import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).parents[1]
SCAFFOLD = ROOT / 'scripts' / 'scaffold-service.py'

sys.path.insert(0, str(ROOT / 'scripts'))
import ncc_service_spec as spec_module  # noqa: E402


class ScaffoldTests(unittest.TestCase):
    def run_scaffold(self, *args):
        return subprocess.run(
            [sys.executable, str(SCAFFOLD), *args],
            text=True, capture_output=True, check=False)

    def test_generates_a_valid_package(self):
        with tempfile.TemporaryDirectory() as work:
            target = pathlib.Path(work) / 'my-app'
            result = self.run_scaffold(
                '--name', 'my-app', '--dir', str(target),
                '--image', 'ghcr.io/acme/my-app:latest')
            self.assertEqual(result.returncode, 0, result.stderr)

            self.assertTrue((target / 'Dockerfile').is_file())
            self.assertTrue((target / 'server.mjs').is_file())
            self.assertTrue((target / 'compose.yaml').is_file())
            self.assertTrue((target / '.github' / 'workflows' / 'publish.yml').is_file())

            spec = json.loads((target / 'service.json').read_text())
            normalized = spec_module.validate_descriptor(spec, require_digest=False)
            self.assertEqual(normalized['service_id'], 'my-app')
            self.assertEqual(normalized['compose_service'], 'my-app-app')
            self.assertEqual(normalized['image'], 'ghcr.io/acme/my-app:latest')

            compose = (target / 'compose.yaml').read_text()
            self.assertIn('  my-app-app:', compose)
            self.assertIn('Hello from My App', compose)
            self.assertNotIn('hello-app', compose)

    def test_refuses_a_non_empty_directory_without_force(self):
        with tempfile.TemporaryDirectory() as work:
            target = pathlib.Path(work) / 'taken'
            target.mkdir()
            (target / 'keep.txt').write_text('do not overwrite')
            result = self.run_scaffold('--name', 'taken', '--dir', str(target))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('not empty', result.stderr)
            self.assertFalse((target / 'service.json').exists())


if __name__ == '__main__':
    unittest.main()

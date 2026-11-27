import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).parents[1]
CHECK = ROOT / 'scripts' / 'check-service.py'
EXAMPLE = ROOT / 'examples' / 'hello-service'


class CheckServiceTests(unittest.TestCase):
    def run_check(self, *args):
        return subprocess.run(
            [sys.executable, str(CHECK), *args],
            text=True, capture_output=True, check=False)

    def copy_example(self, work):
        target = pathlib.Path(work) / 'hello'
        shutil.copytree(EXAMPLE, target)
        return target

    def test_example_passes(self):
        result = self.run_check('--package', str(EXAMPLE))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('OK', result.stdout)

    def test_broken_mapping_is_rejected(self):
        with tempfile.TemporaryDirectory() as work:
            target = self.copy_example(work)
            compose = target / 'compose.yaml'
            compose.write_text(compose.read_text().replace(
                '127.0.0.1:${CUSTOM_SERVICE_BACKEND_PORT}:'
                '${CUSTOM_SERVICE_CONTAINER_PORT}',
                '127.0.0.1:9999:8080'))
            result = self.run_check('--package', str(target))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('must map the backend', result.stdout)

    def test_privileged_is_rejected(self):
        with tempfile.TemporaryDirectory() as work:
            target = self.copy_example(work)
            compose = target / 'compose.yaml'
            compose.write_text(compose.read_text().replace(
                '    read_only: true\n',
                '    read_only: true\n    privileged: true\n'))
            result = self.run_check('--package', str(target))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('privileged', result.stdout)

    def test_signed_requires_a_digest(self):
        result = self.run_check('--package', str(EXAMPLE), '--signed')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('pinned by digest', result.stdout)

    def test_json_output(self):
        result = self.run_check('--package', str(EXAMPLE), '--json')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload['ok'])
        self.assertEqual(payload['service'], 'hello')


if __name__ == '__main__':
    unittest.main()

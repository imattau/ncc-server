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
    'publish_server_release', SCRIPTS / 'publish-server-release.py')
RELEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELEASE)


class OriginTests(unittest.TestCase):
    def test_https_ssh_and_scp_forms(self):
        expected = {'owner': 'imattau', 'repo': 'ncc-server'}
        for value in (
            'https://github.com/imattau/ncc-server',
            'https://github.com/imattau/ncc-server.git',
            'https://github.com/imattau/ncc-server/',
            'git@github.com:imattau/ncc-server.git',
            'ssh://git@github.com/imattau/ncc-server',
        ):
            self.assertEqual(RELEASE.parse_origin(value), expected, value)

    def test_other_forges_are_not_guessed(self):
        for value in (
            'https://gitlab.com/imattau/ncc-server',
            'https://github.com/imattau',
            'https://github.com//ncc-server',
            '',
            None,
        ):
            self.assertIsNone(RELEASE.parse_origin(value), value)


class VersionTests(unittest.TestCase):
    def test_version_from_tag(self):
        self.assertEqual(RELEASE.version_from_tag('v0.2.13'), '0.2.13')
        self.assertEqual(RELEASE.version_from_tag('0.2.13'), '0.2.13')
        self.assertIsNone(RELEASE.version_from_tag('main'))
        self.assertIsNone(RELEASE.version_from_tag('v0.2'))
        self.assertIsNone(RELEASE.version_from_tag(None))


class ReleaseInfoTests(unittest.TestCase):
    def git(self, directory, *args):
        subprocess.run(
            ['git', '-C', str(directory), '-c', 'user.name=Test', '-c', 'user.email=test@example.com', *args],
            check=True,
            capture_output=True,
            text=True,
        )

    def test_records_the_checked_out_tag_and_origin(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = pathlib.Path(temporary)
            self.git(project, 'init')
            (project / 'file.txt').write_text('one\n')
            self.git(project, 'add', 'file.txt')
            self.git(project, 'commit', '-m', 'first')
            self.git(project, 'tag', 'v0.2.13')
            self.git(project, 'remote', 'add', 'origin', 'https://github.com/imattau/ncc-server.git')

            info = RELEASE.release_info(project)

            self.assertEqual(info['schema'], 1)
            self.assertEqual(info['tag'], 'v0.2.13')
            self.assertEqual(info['version'], '0.2.13')
            self.assertEqual(info['origin'], 'https://github.com/imattau/ncc-server.git')
            self.assertEqual(len(info['commit']), 40)
            self.assertTrue(info['installedAt'].endswith('Z'))

    def test_untagged_checkouts_have_no_version(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = pathlib.Path(temporary)
            self.git(project, 'init')
            (project / 'file.txt').write_text('one\n')
            self.git(project, 'add', 'file.txt')
            self.git(project, 'commit', '-m', 'first')

            info = RELEASE.release_info(project)

            self.assertIsNone(info['tag'])
            self.assertIsNone(info['version'])

    def test_writes_json_atomically(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = pathlib.Path(temporary) / 'state' / 'release.json'
            RELEASE.atomic_write(output, {'schema': 1, 'version': '0.2.13'})
            self.assertEqual(json.loads(output.read_text())['version'], '0.2.13')
            self.assertEqual(output.stat().st_mode & 0o777, 0o644)


if __name__ == '__main__':
    unittest.main()

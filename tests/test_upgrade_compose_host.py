import argparse
import contextlib
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS = pathlib.Path(__file__).parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

SPEC = importlib.util.spec_from_file_location(
    'upgrade_compose_host', SCRIPTS / 'upgrade-compose-host.py')
UPGRADE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPGRADE)


def git(directory, *args):
    subprocess.run(
        ['git', '-C', str(directory), '-c', 'user.name=Test', '-c', 'user.email=test@example.com', *args],
        check=True,
        capture_output=True,
        text=True,
    )


def make_repo(project, env_text=None, script=True):
    git(project, 'init')
    if env_text is not None:
        (project / '.env').write_text(env_text)
    if script:
        scripts = project / 'scripts'
        scripts.mkdir()
        (scripts / 'install-compose-host.sh').write_text('#!/usr/bin/env bash\nexit 0\n')
    (project / 'compose.yaml').write_text('services: {}\n')
    (project / 'public').mkdir()
    (project / 'public' / 'index.html').write_text('welcome\n')
    git(project, 'add', '.')
    git(project, 'commit', '-m', 'initial')
    git(project, 'tag', 'v0.2.13')


class TargetTests(unittest.TestCase):
    def test_normalises_bare_versions(self):
        self.assertEqual(UPGRADE.validate_target('0.2.13'), 'v0.2.13')
        self.assertEqual(UPGRADE.validate_target('v0.2.13'), 'v0.2.13')

    def test_rejects_anything_but_a_release_tag(self):
        for value in (None, '', 'main', 'v0.2', 'v0.2.13; rm -rf /'):
            with self.assertRaises(UPGRADE.UpgradeError):
                UPGRADE.validate_target(value)


class PinTests(unittest.TestCase):
    def test_pins_upstream_images_and_preserves_custom_ones(self):
        lines = [
            'SIDECAR_IMAGE=ghcr.io/imattau/ncc-server-sidecar:0.2.12',
            'RELAY_IMAGE="ghcr.io/imattau/ncc-server-relay:latest"',
            'NPANEL_IMAGE=ghcr.io/myfork/npanel:latest',
            'SEARCH_IMAGE=ghcr.io/imattau/ncc-server-search@sha256:' + 'a' * 64,
            '# CADDY_IMAGE=ghcr.io/imattau/ncc-server-caddy:latest',
        ]
        pinned, updated, skipped = UPGRADE.plan_env_pins(lines, '0.2.13')

        self.assertIn('SIDECAR_IMAGE=ghcr.io/imattau/ncc-server-sidecar:0.2.13', pinned)
        self.assertIn('RELAY_IMAGE="ghcr.io/imattau/ncc-server-relay:0.2.13"', pinned)
        self.assertIn('NPANEL_IMAGE=ghcr.io/myfork/npanel:latest', pinned)
        self.assertIn('SEARCH_IMAGE=ghcr.io/imattau/ncc-server-search@sha256:' + 'a' * 64, pinned)
        self.assertIn('CADDY_IMAGE=ghcr.io/imattau/ncc-server-caddy:0.2.13', pinned)
        self.assertIn('SIDECAR_IMAGE', updated)
        self.assertIn('CADDY_IMAGE', updated)
        self.assertIn('NPANEL_IMAGE', skipped)
        self.assertIn('SEARCH_IMAGE', skipped)
        # Missing standard values are added with the release tag.
        self.assertTrue(any(line.startswith('TOR_IMAGE=ghcr.io/imattau/ncc-server-tor:0.2.13') for line in pinned))

    def test_a_commented_custom_caddy_value_is_left_alone(self):
        lines = ['# CADDY_IMAGE=ghcr.io/myfork/caddy:latest']
        pinned, updated, skipped = UPGRADE.plan_env_pins(lines, '0.2.13')
        self.assertEqual(pinned[0], lines[0])
        self.assertNotIn('CADDY_IMAGE', updated)
        self.assertIn('CADDY_IMAGE', skipped)

    def test_empty_values_get_the_default_upstream_image(self):
        pinned, updated, _ = UPGRADE.plan_env_pins(['SIDECAR_IMAGE='], '0.2.13')
        self.assertIn('SIDECAR_IMAGE=ghcr.io/imattau/ncc-server-sidecar:0.2.13', pinned)
        self.assertIn('SIDECAR_IMAGE', updated)


class ReleaseImageTests(unittest.TestCase):
    def test_only_release_owned_images_are_checked(self):
        lines = [
            'SIDECAR_IMAGE=ghcr.io/imattau/ncc-server-sidecar:0.2.12',
            'NPANEL_IMAGE=ghcr.io/myfork/npanel:latest',
            'SEARCH_IMAGE=ghcr.io/imattau/ncc-server-search@sha256:' + 'a' * 64,
            '# CADDY_IMAGE=ghcr.io/imattau/ncc-server-caddy:latest',
        ]
        pinned, _, _ = UPGRADE.plan_env_pins(lines, '0.2.13')
        refs = UPGRADE.image_refs_to_pin(pinned, '0.2.13')

        self.assertIn('ghcr.io/imattau/ncc-server-sidecar:0.2.13', refs)
        self.assertIn('ghcr.io/imattau/ncc-server-caddy:0.2.13', refs)
        self.assertIn('ghcr.io/imattau/ncc-server-tor:0.2.13', refs)
        self.assertNotIn('ghcr.io/myfork/npanel:latest', refs)
        self.assertFalse(any('@sha256:' in ref for ref in refs))

    def test_a_missing_image_fails_with_one_clear_error(self):
        missing = 'ghcr.io/imattau/ncc-server-ditto-web:0.2.13'
        with mock.patch.object(UPGRADE, 'image_manifest_exists', return_value=False):
            with self.assertRaises(UPGRADE.UpgradeError) as caught:
                UPGRADE.check_release_images([missing])

        message = str(caught.exception)
        self.assertIn('not published yet', message)
        self.assertIn(missing, message)

    def test_published_images_pass(self):
        with mock.patch.object(UPGRADE, 'image_manifest_exists', return_value=True):
            UPGRADE.check_release_images(['ghcr.io/imattau/ncc-server-sidecar:0.2.13'])

    def test_a_stale_docker_login_is_retried_anonymously(self):
        ref = 'ghcr.io/imattau/ncc-server-sidecar:0.2.13'
        denied = subprocess.CompletedProcess(
            [], 1, '', 'unauthorized: authentication required')
        ok = subprocess.CompletedProcess([], 0, '{}', '')
        with mock.patch.object(UPGRADE, '_ghcr_manifest_exists', return_value=None), \
                mock.patch.object(UPGRADE.subprocess, 'run', side_effect=[denied, ok]) as run:
            UPGRADE.check_release_images([ref])

        self.assertEqual(run.call_count, 2)
        anonymous_env = run.call_args_list[1].kwargs.get('env') or {}
        self.assertIn('DOCKER_CONFIG', anonymous_env)

    def test_the_rest_of_a_release_reuses_the_anonymous_check(self):
        first = 'ghcr.io/imattau/ncc-server-sidecar:0.2.13'
        second = 'ghcr.io/imattau/ncc-server-tor:0.2.13'
        denied = subprocess.CompletedProcess([], 1, '', 'denied')
        ok = subprocess.CompletedProcess([], 0, '{}', '')
        with mock.patch.object(UPGRADE, '_ghcr_manifest_exists', return_value=None), \
                mock.patch.object(UPGRADE.subprocess, 'run', side_effect=[denied, ok, ok]) as run:
            UPGRADE.check_release_images([first, second])

        self.assertEqual(run.call_count, 3)
        for call in run.call_args_list[1:]:
            self.assertIn('DOCKER_CONFIG', call.kwargs.get('env') or {})

    def test_the_registry_is_asked_directly_when_docker_cannot_see_it(self):
        ref = 'ghcr.io/imattau/ncc-server-sidecar:0.2.13'
        denied = subprocess.CompletedProcess([], 1, '', 'error during connect')
        with mock.patch.object(UPGRADE, '_ghcr_manifest_exists', return_value=True) as registry, \
                mock.patch.object(UPGRADE.subprocess, 'run', return_value=denied):
            UPGRADE.check_release_images([ref])

        registry.assert_called_once_with(ref)

    def test_a_real_missing_image_still_fails_after_the_anonymous_retry(self):
        missing = 'ghcr.io/imattau/ncc-server-ditto-web:0.2.13'
        denied = subprocess.CompletedProcess([], 1, '', 'unauthorized')
        absent = subprocess.CompletedProcess([], 1, '', 'manifest unknown')
        with mock.patch.object(UPGRADE, '_ghcr_manifest_exists', return_value=None), \
                mock.patch.object(UPGRADE.subprocess, 'run', side_effect=[denied, absent]):
            with self.assertRaises(UPGRADE.UpgradeError) as caught:
                UPGRADE.check_release_images([missing])

        message = str(caught.exception)
        self.assertIn('not published yet', message)
        self.assertIn('could not be checked from this host', message)
        self.assertIn(missing, message)

    def test_the_image_check_can_be_skipped_explicitly(self):
        with mock.patch.object(UPGRADE, 'image_manifest_exists', return_value=False) as check, \
                mock.patch.dict(UPGRADE.os.environ, {'NCC_UPGRADE_SKIP_IMAGE_CHECK': '1'}):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                UPGRADE.check_release_images(['ghcr.io/imattau/ncc-server-tor:0.2.13'])

        check.assert_not_called()
        self.assertIn('NCC_UPGRADE_SKIP_IMAGE_CHECK=1', output.getvalue())

    def test_an_unavailable_registry_check_does_not_block_the_upgrade(self):
        with mock.patch.object(UPGRADE, 'image_manifest_exists', return_value=None):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                UPGRADE.check_release_images(['ghcr.io/imattau/ncc-server-sidecar:0.2.13'])

        self.assertIn('Skipping the release image check', output.getvalue())


class CleanTreeTests(unittest.TestCase):
    def test_ignores_generated_public_files_but_not_compose(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = pathlib.Path(temporary)
            make_repo(project)
            (project / 'public' / 'index.html').write_text('rebuilt\n')
            (project / 'compose.yaml').write_text('services: {changed: true}\n')

            changes = UPGRADE.tracked_changes(project)

            self.assertEqual(changes, ['compose.yaml'])

    def test_clean_tree_has_no_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = pathlib.Path(temporary)
            make_repo(project)
            self.assertEqual(UPGRADE.tracked_changes(project), [])


class DryRunTests(unittest.TestCase):
    ENV = (
        'SIDECAR_IMAGE=ghcr.io/imattau/ncc-server-sidecar:0.2.12\n'
        'CADDY_IMAGE=ghcr.io/imattau/ncc-server-caddy:0.2.12\n'
        'RELAY_IMAGE=ghcr.io/myfork/relay:latest\n'
    )

    def run_upgrade(self, project, status, log, release, lock, *, dry_run=True, target='v0.2.13', manifest_exists=True):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), \
                mock.patch.object(UPGRADE, 'image_manifest_exists', return_value=manifest_exists):
            return UPGRADE.run(argparse.Namespace(
                project_dir=str(project),
                target=target,
                manual=True,
                dry_run=dry_run,
                request=str(project / 'request.json'),
                status=str(status),
                release_file=str(release),
                log_file=str(log),
                lock_file=str(lock),
            ))

    def test_dry_run_validates_and_plans_without_writing_env(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = pathlib.Path(temporary)
            make_repo(project, env_text=self.ENV)
            status = project / 'state' / 'status.json'
            log = project / 'state' / 'upgrade.log'
            release = project / 'state' / 'release.json'
            lock = project / 'state' / 'upgrade.lock'

            code = self.run_upgrade(project, status, log, release, lock)

            self.assertEqual(code, 0)
            payload = json.loads(status.read_text())
            self.assertEqual(payload['state'], 'success')
            self.assertTrue(payload['dryRun'])
            self.assertEqual(payload['target'], 'v0.2.13')
            self.assertIn('SIDECAR_IMAGE', payload['pins']['updated'])
            self.assertIn('RELAY_IMAGE', payload['pins']['skipped'])
            self.assertEqual((project / '.env').read_text(), self.ENV)

    def test_dirty_tracked_file_fails_before_checkout(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = pathlib.Path(temporary)
            make_repo(project, env_text=self.ENV)
            (project / 'compose.yaml').write_text('services: {changed: true}\n')
            status = project / 'state' / 'status.json'
            log = project / 'state' / 'upgrade.log'
            release = project / 'state' / 'release.json'
            lock = project / 'state' / 'upgrade.lock'

            code = self.run_upgrade(project, status, log, release, lock)

            self.assertEqual(code, 1)
            payload = json.loads(status.read_text())
            self.assertEqual(payload['state'], 'failed')
            self.assertIn('local changes', payload['error'])
            self.assertEqual(payload['step'], 'checkout')

    def test_unpublished_images_fail_before_env_is_rewritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = pathlib.Path(temporary)
            make_repo(project, env_text=self.ENV)
            status = project / 'state' / 'status.json'
            log = project / 'state' / 'upgrade.log'
            release = project / 'state' / 'release.json'
            lock = project / 'state' / 'upgrade.lock'

            code = self.run_upgrade(
                project, status, log, release, lock, dry_run=False, manifest_exists=False)

            self.assertEqual(code, 1)
            payload = json.loads(status.read_text())
            self.assertEqual(payload['state'], 'failed')
            self.assertEqual(payload['step'], 'images')
            self.assertIn('not published yet', payload['error'])
            self.assertEqual((project / '.env').read_text(), self.ENV)


class FullRunTests(unittest.TestCase):
    ENV = (
        'SIDECAR_IMAGE=ghcr.io/imattau/ncc-server-sidecar:0.2.13\n'
        'CADDY_IMAGE=ghcr.io/imattau/ncc-server-caddy:0.2.13\n'
        'RELAY_IMAGE=ghcr.io/myfork/relay:latest\n'
    )

    def test_checkout_pin_install_and_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = pathlib.Path(temporary)
            make_repo(project, env_text=self.ENV)
            # A changed installer in the target release proves the checkout
            # happened before the runner executed it.
            script = project / 'scripts' / 'install-compose-host.sh'
            script.write_text(
                '#!/usr/bin/env bash\n'
                'printf "ran\\n" > "$(dirname "$0")/../installer-ran.txt"\n'
            )
            (project / 'new.txt').write_text('next release\n')
            git(project, 'add', 'new.txt', 'scripts/install-compose-host.sh')
            git(project, 'commit', '-m', 'next release')
            git(project, 'tag', 'v0.2.14')
            git(project, 'checkout', 'v0.2.13')

            status = project / 'state' / 'status.json'
            log = project / 'state' / 'upgrade.log'
            release = project / 'state' / 'release.json'
            lock = project / 'state' / 'upgrade.lock'

            with contextlib.redirect_stdout(io.StringIO()), \
                    mock.patch.object(UPGRADE, 'image_manifest_exists', return_value=True):
                code = UPGRADE.run(argparse.Namespace(
                    project_dir=str(project),
                    target='v0.2.14',
                    manual=True,
                    dry_run=False,
                    request=str(project / 'request.json'),
                    status=str(status),
                    release_file=str(release),
                    log_file=str(log),
                    lock_file=str(lock),
                ))

            self.assertEqual(code, 0)
            payload = json.loads(status.read_text())
            self.assertEqual(payload['state'], 'success')
            self.assertEqual(payload['target'], 'v0.2.14')
            self.assertIn('SIDECAR_IMAGE', payload['pins']['updated'])
            self.assertIn('RELAY_IMAGE', payload['pins']['skipped'])
            env_text = (project / '.env').read_text()
            self.assertIn('SIDECAR_IMAGE=ghcr.io/imattau/ncc-server-sidecar:0.2.14', env_text)
            self.assertIn('CADDY_IMAGE=ghcr.io/imattau/ncc-server-caddy:0.2.14', env_text)
            self.assertIn('RELAY_IMAGE=ghcr.io/myfork/relay:latest', env_text)
            self.assertIn('TOR_IMAGE=ghcr.io/imattau/ncc-server-tor:0.2.14', env_text)
            self.assertTrue((project / 'installer-ran.txt').is_file())
            self.assertEqual(
                subprocess.run(
                    ['git', '-C', str(project), 'describe', '--tags', '--exact-match', 'HEAD'],
                    check=True, capture_output=True, text=True,
                ).stdout.strip(),
                'v0.2.14',
            )
            recorded = json.loads(release.read_text())
            self.assertEqual(recorded['tag'], 'v0.2.14')
            self.assertEqual(recorded['version'], '0.2.14')
            self.assertTrue(payload['warning'])
            self.assertTrue((project / 'state' / 'env-backups').is_dir())


if __name__ == '__main__':
    unittest.main()

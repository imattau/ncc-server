import importlib.util
import pathlib
import sys
import unittest
from unittest import mock

SCRIPTS = pathlib.Path(__file__).parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

SPEC = importlib.util.spec_from_file_location(
    'provision_compose_services', SCRIPTS / 'provision-compose-services.py')
PROVISION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROVISION)


class ForcePublishTests(unittest.TestCase):
    def fake_request(self, details):
        calls = []

        def request(path, method='GET', data=None, timeout=60):
            calls.append({'path': path, 'method': method, 'timeout': timeout})
            return {'details': details}

        return request, calls

    def test_uses_a_long_timeout_for_the_combined_cycle(self):
        request, calls = self.fake_request([{'serviceId': 2, 'success': True}])

        with mock.patch.object(PROVISION, 'request', side_effect=request):
            PROVISION.force_publish({'id': 2, 'service_id': 'web'})

        self.assertEqual(calls[0]['path'], '/api/services/republish')
        self.assertEqual(calls[0]['method'], 'POST')
        self.assertEqual(calls[0]['timeout'], 600)

    def test_target_failure_names_the_service(self):
        request, _ = self.fake_request([{'serviceId': 2, 'success': False, 'error': 'relay timeout'}])

        with mock.patch.object(PROVISION, 'request', side_effect=request):
            with self.assertRaisesRegex(RuntimeError, 'relay timeout'):
                PROVISION.force_publish({'id': 2, 'service_id': 'web'})

    def test_all_services_mode_reports_every_failure(self):
        request, _ = self.fake_request([
            {'serviceId': 2, 'success': True},
            {'serviceId': 3, 'success': False, 'error': 'relay timeout'},
            {'serviceId': 4, 'success': False, 'error': 'tor unavailable'},
        ])

        with mock.patch.object(PROVISION, 'request', side_effect=request):
            with self.assertRaisesRegex(RuntimeError, '3: relay timeout.*4: tor unavailable'):
                PROVISION.force_publish({'id': 2, 'service_id': 'web'}, all_services=True)


class VisibilityTests(unittest.TestCase):
    def setUp(self):
        self.previous = dict(PROVISION.VISIBILITY_POLICY)
        PROVISION.VISIBILITY_POLICY.update({
            'private_services': set(),
            'recipients': [],
            'operator': '11' * 32,
        })

    def tearDown(self):
        PROVISION.VISIBILITY_POLICY.clear()
        PROVISION.VISIBILITY_POLICY.update(self.previous)

    def test_reprovision_keeps_an_existing_private_mode(self):
        existing = {
            'service_id': 'search',
            'config': {
                'service_mode': 'private',
                'ncc05_recipients': ['22' * 32],
            },
        }
        config = PROVISION.visible_config(
            {'service_mode': 'public', 'ncc05_recipients': [], 'port': 8447},
            existing,
            'search',
        )
        self.assertEqual(config['service_mode'], 'private')
        self.assertEqual(config['ncc05_recipients'], ['22' * 32, '11' * 32])
        self.assertEqual(config['port'], 8447)

    def test_env_private_forces_a_new_service_private(self):
        PROVISION.VISIBILITY_POLICY['private_services'] = {'npanel'}
        config = PROVISION.visible_config(
            {'service_mode': 'public', 'ncc05_recipients': []}, None, 'npanel')
        self.assertEqual(config['service_mode'], 'private')
        self.assertEqual(config['ncc05_recipients'], ['11' * 32])

    def test_env_private_adds_configured_recipients(self):
        PROVISION.VISIBILITY_POLICY['private_services'] = {'admin'}
        PROVISION.VISIBILITY_POLICY['recipients'] = ['33' * 32]
        config = PROVISION.visible_config(
            {'service_mode': 'public', 'ncc05_recipients': []}, None, 'admin')
        self.assertEqual(config['ncc05_recipients'], ['33' * 32, '11' * 32])

    def test_public_stays_public(self):
        config = PROVISION.visible_config(
            {'service_mode': 'public', 'ncc05_recipients': []}, None, 'web')
        self.assertEqual(config['service_mode'], 'public')


if __name__ == '__main__':
    unittest.main()

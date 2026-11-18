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


if __name__ == '__main__':
    unittest.main()

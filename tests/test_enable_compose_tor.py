import importlib.util
import pathlib
import sys
import unittest
from unittest import mock

SCRIPTS = pathlib.Path(__file__).parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

SPEC = importlib.util.spec_from_file_location(
    'enable_compose_tor', SCRIPTS / 'enable-compose-tor.py')
ENABLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ENABLE)


class EnableComposeTorTests(unittest.TestCase):
    def setUp(self):
        self.records = {
            service_id: {
                'id': index,
                'service_id': service_id,
                'type': 'relay' if service_id == 'relay' else 'custom',
                'config': {
                    'protocols': {'ipv4': True, 'ipv6': False, 'tor': False},
                    'profile': {'name': 'keep-me'},
                    'refresh_interval_minutes': 120,
                },
                'state': {},
            }
            for index, service_id in enumerate(
                ('web', 'relay', 'npanel', 'ditto', 'search', 'admin', 'addr'), start=2)
        }
        self.republished = 0

    def fake_api(self, path, method='GET', body=None):
        if path == '/api/services':
            return list(self.records.values())
        if path == '/api/services/republish' and method == 'POST':
            self.republished += 1
            for service_id, record in self.records.items():
                config = record['config']
                control = config.get('tor_control') or {}
                if config.get('protocols', {}).get('tor') and control.get('enabled'):
                    record['state']['last_onion_address'] = f'{service_id}.onion'
            return {'success': True, 'details': []}
        prefix = '/api/service/'
        if path.startswith(prefix) and method == 'PUT':
            service_id = next(
                key for key, record in self.records.items()
                if str(record['id']) == path[len(prefix):])
            self.records[service_id]['config'].update(body['config'])
            return {'success': True}
        raise AssertionError(f'unexpected API call {method} {path}')

    def test_every_service_gets_a_target_and_addr_reuses_the_web_onion(self):
        env = {
            'CONTENT_PORT': '8080',
            'TOR_NPANEL_PORT': '18045',
            'TOR_DITTO_WEB_PORT': '18046',
            'TOR_SEARCH_PORT': '18047',
            'TOR_ADMIN_PORT': '18048',
        }

        with mock.patch.object(ENABLE.os, 'geteuid', return_value=0), \
             mock.patch.object(ENABLE, 'read_env', return_value=env), \
             mock.patch.object(ENABLE, 'require_listener'), \
             mock.patch.object(ENABLE.tor_control, 'configure', return_value='password') as configure, \
             mock.patch.object(ENABLE, 'api', side_effect=self.fake_api):
            ENABLE.main()

        configure.assert_called_once()

        expected_ports = {
            'web': 8080,
            'relay': 13131,
            'npanel': 18045,
            'ditto': 18046,
            'search': 18047,
            'admin': 18048,
        }
        for service_id, port in expected_ports.items():
            config = self.records[service_id]['config']
            self.assertTrue(config['protocols']['tor'], service_id)
            self.assertEqual(config['local_port'], port, service_id)
            self.assertEqual(config['tor_control'], {
                'enabled': True,
                'host': '127.0.0.1',
                'port': 9051,
                'password': 'password',
            })
            self.assertEqual(config['profile'], {'name': 'keep-me'})
            self.assertEqual(config['refresh_interval_minutes'], 120)

        addr = self.records['addr']['config']
        self.assertEqual(addr['onion_address'], 'web.onion')
        self.assertEqual(addr['tor_control'], {'enabled': False})
        self.assertEqual(self.republished, 2)


if __name__ == '__main__':
    unittest.main()

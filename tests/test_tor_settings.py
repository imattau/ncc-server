import importlib.util
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).parents[1] / 'scripts'


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SETTINGS = load('tor_settings')
CONTROL = load('tor_control')


class TorSettingsTests(unittest.TestCase):
    def test_enable_service_tor_creates_a_control_managed_onion(self):
        config = {
            'protocols': {'ipv4': True, 'ipv6': False, 'tor': False},
            'onion_address': 'old.onion',
            'port': 8444,
        }

        updated = SETTINGS.enable_service_tor(
            config, password='secret', local_port=13131,
        )

        self.assertEqual(updated['protocols'], {'ipv4': True, 'ipv6': False, 'tor': True})
        self.assertEqual(updated['local_port'], 13131)
        self.assertEqual(updated['tor_control'], {
            'enabled': True,
            'host': '127.0.0.1',
            'port': 9051,
            'password': 'secret',
        })
        self.assertIsNone(updated['onion_address'])
        self.assertEqual(updated['port'], 8444)
        self.assertEqual(config['protocols']['tor'], False)

    def test_reuse_onion_publishes_without_creating_another_service(self):
        config = {'protocols': {'ipv4': True, 'ipv6': False, 'tor': False}}

        updated = SETTINGS.reuse_onion_endpoint(config, 'web.onion')

        self.assertEqual(updated['protocols'], {'ipv4': True, 'ipv6': False, 'tor': True})
        self.assertEqual(updated['onion_address'], 'web.onion')
        self.assertEqual(updated['tor_control'], {'enabled': False})

    def test_local_port_for_maps_each_service_to_its_loopback_target(self):
        env = {
            'CONTENT_PORT': '8080',
            'TOR_NPANEL_PORT': '19045',
            'TOR_DITTO_WEB_PORT': '19046',
            'TOR_SEARCH_PORT': '19047',
            'TOR_ADMIN_PORT': '19048',
        }

        self.assertEqual(SETTINGS.local_port_for('web', env), 8080)
        self.assertEqual(SETTINGS.local_port_for('addr', env), 8080)
        self.assertEqual(SETTINGS.local_port_for('relay', env), 13131)
        self.assertEqual(SETTINGS.local_port_for('npanel', env), 19045)
        self.assertEqual(SETTINGS.local_port_for('ditto', env), 19046)
        self.assertEqual(SETTINGS.local_port_for('search', env), 19047)
        self.assertEqual(SETTINGS.local_port_for('admin', env), 19048)

    def test_local_port_for_uses_defaults_when_env_is_missing_values(self):
        self.assertEqual(SETTINGS.local_port_for('web', {}), 8080)
        self.assertEqual(SETTINGS.local_port_for('npanel', {}), 18045)
        self.assertEqual(SETTINGS.local_port_for('ditto', {}), 18046)
        self.assertEqual(SETTINGS.local_port_for('search', {}), 18047)
        self.assertEqual(SETTINGS.local_port_for('admin', {}), 18048)


class TorControlTests(unittest.TestCase):
    def test_existing_password_is_reused_from_any_service(self):
        services = [
            {'config': {'protocols': {'tor': True}}},
            {'config': {'tor_control': {'enabled': True, 'password': 'stored'}}},
        ]

        self.assertEqual(CONTROL.existing_password(services), 'stored')

    def test_existing_password_prefers_web(self):
        services = [
            {'service_id': 'manager', 'config': {'tor_control': {
                'enabled': True, 'password': 'manager'}}},
            {'service_id': 'web', 'config': {'tor_control': {
                'enabled': True, 'password': 'web'}}},
        ]

        self.assertEqual(CONTROL.existing_password(services), 'web')

    def test_existing_password_ignores_an_external_tor_instance(self):
        services = [
            {'config': {'tor_control': {
                'enabled': True, 'password': 'external',
                'host': '10.0.0.9', 'port': 9051,
            }}},
        ]

        self.assertIsNone(CONTROL.existing_password(services))

    def test_missing_password_is_none(self):
        self.assertIsNone(CONTROL.existing_password([
            {'config': {}},
            {'config': {'tor_control': {'enabled': True}}},
        ]))

    def test_password_updates_only_enabled_services_with_an_old_password(self):
        services = [
            {'id': 2, 'config': {'tor_control': {'enabled': True, 'password': 'old'}}},
            {'id': 3, 'config': {'tor_control': {'enabled': True, 'password': 'new'}}},
            {'id': 4, 'config': {'tor_control': {'enabled': False}}},
            {'id': 5, 'config': {}},
            {'id': 6, 'config': {'tor_control': {
                'enabled': True, 'password': 'old', 'host': '10.0.0.9', 'port': 9051,
            }}},
        ]

        updates = list(CONTROL.password_updates(services, 'new'))

        self.assertEqual([(service['id'], control['password']) for service, control in updates],
                         [(2, 'old')])

    def test_control_strings_escape_quotes_and_backslashes(self):
        self.assertEqual(CONTROL._quote('a"b\\c'), 'a\\"b\\\\c')


if __name__ == '__main__':
    unittest.main()

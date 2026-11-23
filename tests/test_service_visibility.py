import importlib.util
import pathlib
import sys
import unittest

SCRIPTS = pathlib.Path(__file__).parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

SPEC = importlib.util.spec_from_file_location(
    'service_visibility', SCRIPTS / 'service_visibility.py')
VISIBILITY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VISIBILITY)

OPERATOR = '11' * 32
ADMIN = '22' * 32
FRIEND = '33' * 32


class NpubTests(unittest.TestCase):
    def test_round_trips_npub_and_hex(self):
        npub = VISIBILITY.encode_npub(OPERATOR)
        self.assertTrue(npub.startswith('npub1'))
        self.assertEqual(VISIBILITY.decode_npub(npub), OPERATOR)
        self.assertEqual(VISIBILITY.parse_pubkey(npub), OPERATOR)
        self.assertEqual(VISIBILITY.parse_pubkey(OPERATOR.upper()), OPERATOR)

    def test_rejects_a_bad_checksum(self):
        npub = VISIBILITY.encode_npub(OPERATOR)
        broken = npub[:-1] + ('q' if npub[-1] != 'q' else 'p')
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            VISIBILITY.decode_npub(broken)


class RecipientTests(unittest.TestCase):
    def test_flattens_and_deduplicates(self):
        npub = VISIBILITY.encode_npub(FRIEND)
        values = [f'{npub},{OPERATOR}', FRIEND, '', None]
        self.assertEqual(VISIBILITY.normalize_recipients(values), [FRIEND, OPERATOR])

    def test_operator_and_admins_are_added(self):
        recipients = VISIBILITY.resolve_recipients(
            [FRIEND], operator=OPERATOR, admins=[ADMIN], include_admins=True)
        self.assertEqual(recipients, [FRIEND, OPERATOR, ADMIN])

    def test_admins_can_be_excluded(self):
        recipients = VISIBILITY.resolve_recipients(
            [FRIEND], operator=OPERATOR, admins=[ADMIN], include_admins=False)
        self.assertEqual(recipients, [FRIEND, OPERATOR])

    def test_an_existing_operator_is_not_duplicated(self):
        recipients = VISIBILITY.resolve_recipients(
            [OPERATOR, FRIEND], operator=OPERATOR, admins=[], include_admins=True)
        self.assertEqual(recipients, [OPERATOR, FRIEND])


class ConfigTests(unittest.TestCase):
    def test_set_visibility_keeps_unrelated_fields(self):
        config = {'port': 8448, 'service_mode': 'public', 'ncc05_recipients': []}
        updated = VISIBILITY.set_visibility(config, 'private', [FRIEND])
        self.assertEqual(updated['port'], 8448)
        self.assertEqual(updated['service_mode'], 'private')
        self.assertEqual(updated['ncc05_recipients'], [FRIEND])
        self.assertEqual(config['service_mode'], 'public')

    def test_recipients_accept_existing_hex_and_npub(self):
        npub = VISIBILITY.encode_npub(ADMIN)
        config = {'service_mode': 'private', 'ncc05_recipients': [FRIEND, npub]}
        self.assertEqual(VISIBILITY.recipients_for(config), [FRIEND, ADMIN])


if __name__ == '__main__':
    unittest.main()

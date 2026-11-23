import importlib.util
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / 'scripts' / 'apply-shared-identity.py'
SPEC = importlib.util.spec_from_file_location('apply_shared_identity', MODULE_PATH)
IDENTITY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IDENTITY)


class IdentitySetupTests(unittest.TestCase):
    def test_migration_updates_signers_and_operator_admin_atomically(self):
        with tempfile.TemporaryDirectory() as temp:
            db_path = Path(temp) / 'sidecar.db'
            with sqlite3.connect(db_path) as db:
                db.executescript('''
                    CREATE TABLE services (
                      id INTEGER PRIMARY KEY, service_nsec TEXT, config TEXT, state TEXT
                    );
                    CREATE TABLE admins (pubkey TEXT PRIMARY KEY, status TEXT);
                    INSERT INTO services VALUES (1, 'old-manager', '{"port": 3000}', '{}');
                    INSERT INTO services VALUES (2, 'old-web', '{"port": 8443}', '{}');
                    INSERT INTO services VALUES (3, 'dedicated-key', '{"service_identity": "dedicated"}', '{}');
                    INSERT INTO admins VALUES ('old-admin', 'active');
                ''')

            IDENTITY.migrate_database(db_path, 'new-shared-nsec', 'a' * 64)

            with sqlite3.connect(db_path) as db:
                services = db.execute('SELECT service_nsec, config FROM services ORDER BY id').fetchall()
                admins = db.execute('SELECT pubkey, status FROM admins').fetchall()
            self.assertEqual([row[0] for row in services], ['new-shared-nsec', 'new-shared-nsec', 'dedicated-key'])
            self.assertEqual([row[1] for row in services], [
                '{"port": 3000}', '{"port": 8443}', '{"service_identity": "dedicated"}',
            ])
            self.assertEqual(admins, [('a' * 64, 'active')])

    def test_relay_env_replaces_private_key_and_creates_protected_file(self):
        with tempfile.TemporaryDirectory() as temp:
            env_path = Path(temp) / 'ditto-relay.env'
            env_path.write_text('RELAY_URL=wss://relay.example:8444/\nNOSTR_SECRET_KEY=old\nOTHER=value\n')
            IDENTITY.update_relay_env(env_path, 'new-shared-nsec', 'wss://relay.example:8444/')
            content = env_path.read_text()
            self.assertIn('NOSTR_SECRET_KEY=new-shared-nsec', content)
            self.assertIn('OTHER=value', content)
            self.assertNotIn('NOSTR_SECRET_KEY=old', content)
            self.assertEqual(env_path.stat().st_mode & 0o777, 0o600)

    def test_new_relay_env_requires_public_wss_url(self):
        with tempfile.TemporaryDirectory() as temp:
            env_path = Path(temp) / 'ditto-relay.env'
            with self.assertRaises(RuntimeError):
                IDENTITY.update_relay_env(env_path, 'shared', '')
            self.assertFalse(env_path.exists())


if __name__ == '__main__':
    unittest.main()

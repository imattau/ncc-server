import socket
import sys
import threading
import unittest
import pathlib

ROOT = pathlib.Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

import tor_control  # noqa: E402


class OnionRemovalTests(unittest.TestCase):
    def serve_once(self, replies):
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        received = []

        def run():
            conn, _ = listener.accept()
            with conn:
                for reply in replies:
                    data = b''
                    while b'\r\n' not in data:
                        chunk = conn.recv(1024)
                        if not chunk:
                            break
                        data += chunk
                    received.append(data)
                    conn.sendall(reply)
            listener.close()

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return port, received, thread

    def test_removes_an_onion(self):
        port, received, thread = self.serve_once([b'250 OK\r\n', b'250 OK\r\n'])
        self.assertTrue(tor_control.remove_onion(
            'secret', 'abcdef.onion', host='127.0.0.1', port=port))
        thread.join(timeout=2)
        self.assertIn(b'AUTHENTICATE "secret"', received[0])
        self.assertIn(b'DEL_ONION abcdef', received[1])

    def test_rejected_command_raises(self):
        port, _received, thread = self.serve_once([b'250 OK\r\n', b'552 nope\r\n'])
        with self.assertRaisesRegex(RuntimeError, 'DEL_ONION'):
            tor_control.remove_onion(
                'secret', 'abcdef.onion', host='127.0.0.1', port=port)
        thread.join(timeout=2)

    def test_empty_address_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'no onion'):
            tor_control.remove_onion('secret', '')


if __name__ == '__main__':
    unittest.main()

const relayUrl = process.argv[2];
if (!relayUrl || !relayUrl.startsWith('wss://')) {
  throw new Error('Usage: node scripts/test-ditto-wss.mjs wss://<relay-host>:8443/relay/');
}

if (typeof WebSocket === 'undefined') {
  throw new Error('Node.js 22 or newer with global WebSocket is required.');
}

const timeoutMs = 12_000;
const subscriptionId = `ncc-smoke-${Date.now()}`;
const socket = new WebSocket(relayUrl);

await new Promise((resolve, reject) => {
  const fail = (error) => {
    clearTimeout(timer);
    if (socket.readyState < WebSocket.CLOSING) socket.close();
    reject(error);
  };
  const timer = setTimeout(() => fail(new Error('Timed out waiting for WSS/NIP-01 EOSE.')), timeoutMs);
  socket.addEventListener('open', () => {
    console.log(`WSS connected: ${relayUrl}`);
    socket.send(JSON.stringify(['REQ', subscriptionId, { kinds: [0], limit: 1 }]));
  }, { once: true });
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return fail(new Error('Relay returned a non-JSON WebSocket frame.'));
    }
    if (message[0] === 'EOSE' && message[1] === subscriptionId) {
      clearTimeout(timer);
      resolve(message);
    }
    if (message[0] === 'NOTICE') {
      fail(new Error(`Relay NOTICE: ${message[1]}`));
    }
  });
  socket.addEventListener('error', () => {
    fail(new Error('WSS connection failed. Check the listener, certificate, and relay logs.'));
  }, { once: true });
  socket.addEventListener('close', (event) => {
    fail(new Error(`Relay closed before EOSE (code ${event.code}).`));
  }, { once: true });
});

socket.close();
console.log('NIP-01 REQ/EOSE exchange succeeded over WSS.');

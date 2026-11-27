import { createServer } from 'node:http';

const port = Number(process.env.PORT || 8080);
const greeting = process.env.GREETING || 'Hello from NCC';

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Hello Service</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #0f172a;
        color: #e2e8f0;
      }
      main {
        max-width: 42rem;
        padding: 2rem;
        text-align: center;
      }
      h1 { font-size: clamp(2rem, 6vw, 4rem); margin: 0 0 1rem; }
      p { line-height: 1.6; color: #94a3b8; }
      code { color: #86efac; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(greeting)}</h1>
      <p>This page is served by a container image that follows the NCC service contract.</p>
      <p>Try <code>/healthz</code> for the health probe.</p>
    </main>
  </body>
</html>
`;

const server = createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end('{"ok":true}\n');
    return;
  }

  if (request.url !== '/' && request.url !== '') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found\n');
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  });
  response.end(page);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`hello-service listening on 0.0.0.0:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

// The crawler process's private HTTP surface, used by the API process.
//
// Deliberately not exposed publicly: compose.yaml publishes no port for the
// crawler container, so this listener is only reachable on the compose
// network (or loopback, for the systemd split). There is no auth token on
// purpose -- the two endpoints can do exactly two things:
//
//   GET  /internal/status  read the in-memory crawl/relay health snapshot
//                          that only exists in this process
//   POST /internal/ingest  hand a raw relay event to the normal ingest path
//
// An unauthenticated caller on that network can therefore *ask* for a
// candidate to be resolved -- which means the resolver still fetches and
// verifies it exactly as it would for anything a relay delivered -- but
// cannot write a row into the index. That is the same trust level the
// crawler already extends to a relay it subscribes to, so a token would add
// ceremony without adding a boundary.

import Fastify from 'fastify';
import { routeEventToCrawlers } from './ingest.js';

// A raw event's `content` can be large (a NIP-23 article, an nsite
// manifest), so allow more than Fastify's 1 MiB default; still bounded, so
// one caller cannot exhaust memory by posting an arbitrary body.
const BODY_LIMIT_BYTES = 2_000_000;

function isPlausibleEvent(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof value.kind === 'number' &&
    typeof value.pubkey === 'string' &&
    typeof value.created_at === 'number' &&
    Array.isArray(value.tags) &&
    typeof value.content === 'string'
  );
}

/**
 * @param {{ crawlMonitor?: { snapshot(): object },
 *           relayLearning?: { snapshot(): object },
 *           crawlers?: object }} options
 */
export function createInternalServer({ crawlMonitor = null, relayLearning = null, crawlers = {} } = {}) {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });

  app.get('/health', async () => ({ ok: true }));

  app.get('/internal/status', async () => ({
    ok: true,
    checkedAt: Date.now(),
    crawlers: crawlMonitor?.snapshot?.() ?? {},
    relayLearning: relayLearning?.snapshot?.() ?? { enabled: false },
  }));

  // Signature/expiry verification is deliberately NOT duplicated here: the
  // crawler's ambient subscriptions already trust whatever the configured
  // relays serve, and this endpoint is how the API's NIP-50 hits reach that
  // same pipeline. It only rejects shapes no adapter could use.
  app.post('/internal/ingest', async (req, reply) => {
    const event = req.body?.event;
    if (!isPlausibleEvent(event)) {
      return reply.code(400).send({ error: 'expected { event: { kind, pubkey, created_at, tags, content } }' });
    }
    return { ingested: routeEventToCrawlers(crawlers, event) };
  });

  return app;
}

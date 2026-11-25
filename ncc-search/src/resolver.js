// Implements the anchored resolution contract from NCC-02 ("Client Resolution
// Algorithm") and NCC-05 (section 7), by composing the two reference resolver
// libraries the ncc-06 sidecar itself depends on (ncc-02-js, ncc-05-js) rather
// than re-implementing signature/expiry/pin logic here.
//
// Order of operations (normative):
//   1. Resolve the NCC-02 Service Record (kind 30059) for (pubkey, serviceId).
//      This is the identity/trust anchor: signature + expiry are checked by
//      NCC02Resolver, which also folds in Kind 30060 attestations and Kind
//      30061 revocations.
//   2. A revoked anchor is never resolved further and is never indexed as
//      reachable.
//   3. Resolve the NCC-05 Locator (kind 30058, d=`${serviceId}-locator`) for
//      the same pubkey. If a fresh, decodable record exists, its best
//      endpoint (by NCC-05's own priority/family ordering) is preferred for
//      reachability.
//   4. Only if NCC-05 resolution yields nothing usable does the NCC-02 `u`
//      tag serve as a fallback endpoint, with NCC-02 trust semantics still
//      applied.
//
// This module does not decrypt private/encrypted locators: NCC05Resolver is
// called with no signer, so an encrypted payload simply fails to parse and is
// treated as "no locator" (see "Plaintext exception", NCC-05 section 5.2).
// That is intentional here, not a bug: this project only indexes services
// that have opted out of locator privacy, same stance as the sidecar's own
// README.

import { NCC02Resolver, NCC02Error } from 'ncc-02-js';
import { NCC05Resolver, selectEndpoints } from 'ncc-05-js';

export class AnchoredResolver {
  /**
   * @param {string[]} relays
   * @param {import('nostr-tools').SimplePool} pool
   * @param {{ trustedCAPubkeys?: string[] }} [options]
   */
  constructor(relays, pool, options = {}) {
    this.relays = relays;
    this.ncc02 = new NCC02Resolver(relays, {
      pool,
      trustedCAPubkeys: options.trustedCAPubkeys || [],
    });
    this.ncc05 = new NCC05Resolver({ bootstrapRelays: relays, pool });
  }

  /**
   * @param {string} pubkey hex pubkey
   * @param {string} serviceId the NCC-02 `d` tag value
   * @returns {Promise<ResolvedService>}
   */
  async resolveService(pubkey, serviceId) {
    /** @type {ResolvedService} */
    const result = {
      pubkey,
      serviceId,
      anchored: false,
      anchorError: null,
      attestationCount: 0,
      isRevoked: false,
      isPrivate: false,
      locatorPresent: false,
      locatorError: null,
      endpoint: null,
      fingerprint: null,
      family: null,
      usedFallback: false,
      ttlSeconds: null,
    };

    try {
      const anchor = await this.ncc02.resolve(pubkey, serviceId);
      result.anchored = true;
      result.attestationCount = anchor.attestationCount;
      result.isRevoked = anchor.isRevoked;
      result.isPrivate = anchor.isPrivate === true;
      result.anchorEndpoint = anchor.endpoint || null;
      result.anchorFingerprint = anchor.fingerprint || null;
    } catch (err) {
      result.anchorError =
        err instanceof NCC02Error ? `${err.code}: ${err.message}` : String(err);
    }

    // A revoked anchor is dead regardless of what NCC-05 says.
    if (result.anchored && result.isRevoked) {
      return result;
    }

    try {
      const payload = await this.ncc05.resolve(
        pubkey,
        undefined,
        `${serviceId}-locator`,
        { gossip: false },
      );
      if (payload && Array.isArray(payload.endpoints) && payload.endpoints.length) {
        result.locatorPresent = true;
        result.ttlSeconds = payload.ttl ?? null;
        const [best] = selectEndpoints(payload.endpoints);
        result.endpoint = best.url;
        // NCC-02: a service record's own `k` keeps applying to a privately or
        // separately resolved endpoint. The locator's `k` only fills the gap.
        result.fingerprint = result.anchorFingerprint || best.k || null;
        result.family = best.family || null;
      }
    } catch (err) {
      result.locatorError = String(err && err.message ? err.message : err);
    }

    // Fallback: NCC-02's own `u`, only if NCC-05 gave us nothing usable.
    if (!result.endpoint && result.anchored && result.anchorEndpoint) {
      result.endpoint = result.anchorEndpoint;
      result.fingerprint = result.anchorFingerprint;
      result.usedFallback = true;
    }

    return result;
  }

  close() {
    this.ncc02.close();
    this.ncc05.close();
  }
}

/**
 * @typedef {Object} ResolvedService
 * @property {string} pubkey
 * @property {string} serviceId
 * @property {boolean} anchored - whether an NCC-02 Service Record was found and verified
 * @property {string|null} anchorError
 * @property {number} attestationCount
 * @property {boolean} isRevoked
 * @property {boolean} isPrivate - anchor opted out of public locator discovery
 * @property {boolean} locatorPresent - whether a usable NCC-05 locator was found
 * @property {string|null} locatorError
 * @property {string|null} endpoint - the endpoint to actually fetch, or null if unresolvable
 * @property {string|null} fingerprint - expected transport-key fingerprint (`k`) for pin checks: the NCC-02 record's, else the locator's
 * @property {string|null} family
 * @property {boolean} usedFallback - true if `endpoint` came from NCC-02 `u`, not NCC-05
 * @property {number|null} ttlSeconds - NCC-05 payload TTL, used to schedule re-crawl
 */

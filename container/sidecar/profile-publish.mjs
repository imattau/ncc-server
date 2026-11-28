/**
 * Kind 0 profile publishing policy for the sidecar.
 *
 * The upstream publish cycle bundles a kind 0 event with every locator
 * refresh. That makes a node look like it edits its profile on every cadence
 * tick even when nothing changed. A kind 0 is replaceable and does not
 * expire, so it only needs a new event when its content changes, on the first
 * publish, or on an explicit republish.
 */

import crypto from 'node:crypto';

// The fields the sidecar publishes. Unlike the upstream inventory hash, this
// includes display_name and nip05, so edits to either are detected.
const PROFILE_FIELDS = ['name', 'display_name', 'about', 'picture', 'nip05'];

/** Stable hash of the public profile fields, or null without a profile. */
export function computeProfileHash(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  const stable = {};
  for (const field of PROFILE_FIELDS) {
    const value = profile[field];
    stable[field] = typeof value === 'string' ? value : null;
  }
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

/**
 * True when this cycle should publish a kind 0.
 *
 * `profileChanged` compares the hash above with the service's saved
 * `last_profile_hash`. `forcePublish` is an explicit republish (admin panel,
 * provisioner, public-IP reconciler), not a cadence tick: the cadence only
 * refreshes expiring NCC-05 locators.
 */
export function shouldPublishProfile({
  profile,
  canPublish,
  forcePublish = false,
  profileChanged = false,
  isFirstRun = false,
} = {}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false;
  if (!canPublish) return false;
  return Boolean(profileChanged || isFirstRun || forcePublish);
}

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeProfileHash, shouldPublishProfile } from '../profile-publish.mjs';

const profile = {
  name: 'harbour_node',
  display_name: 'Harbour Node',
  about: 'A node by the water',
  picture: 'https://example.com/harbour.png',
  nip05: 'harbour@example.com',
};

test('profile hash ignores key order but detects every published field', () => {
  assert.equal(
    computeProfileHash(profile),
    computeProfileHash({ nip05: profile.nip05, picture: profile.picture, about: profile.about,
      display_name: profile.display_name, name: profile.name }),
  );

  for (const field of ['name', 'display_name', 'about', 'picture', 'nip05']) {
    const changed = { ...profile, [field]: `${profile[field]} changed` };
    assert.notEqual(computeProfileHash(changed), computeProfileHash(profile), field);
  }
});

test('profile hash ignores fields the sidecar does not publish', () => {
  assert.equal(
    computeProfileHash({ ...profile, banner: 'https://example.com/banner.png', website: 'https://example.com' }),
    computeProfileHash(profile),
  );
});

test('profile hash is null without a usable profile', () => {
  for (const value of [null, undefined, 'profile', [], 42]) {
    assert.equal(computeProfileHash(value), null, String(value));
  }
});

test('a cadence refresh alone does not publish a profile', () => {
  assert.equal(shouldPublishProfile({
    profile,
    canPublish: true,
    forcePublish: false,
    profileChanged: false,
    isFirstRun: false,
  }), false);
});

test('profile changes, first publish and explicit republishes publish a profile', () => {
  const base = { profile, canPublish: true, forcePublish: false, profileChanged: false, isFirstRun: false };
  assert.equal(shouldPublishProfile({ ...base, profileChanged: true }), true);
  assert.equal(shouldPublishProfile({ ...base, isFirstRun: true }), true);
  assert.equal(shouldPublishProfile({ ...base, forcePublish: true }), true);
});

test('a profile is not published without one or without relays', () => {
  assert.equal(shouldPublishProfile({ profile: null, canPublish: true, profileChanged: true }), false);
  assert.equal(shouldPublishProfile({ profile, canPublish: false, profileChanged: true }), false);
});

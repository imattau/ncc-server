import { test } from 'vitest';
import assert from 'node:assert/strict';

import { isNsfwWarning, shouldBlurMedia } from './nsfw';

test('nsfw-style publisher labels are recognised, however they are written', () => {
  for (const label of ['nsfw', 'NSFW', 'Nudity', 'explicit content', '18+', 'porn']) {
    assert.equal(isNsfwWarning(label), true, label);
  }
});

test('a bare content-warning label (server fallback) is blur-worthy', () => {
  assert.equal(isNsfwWarning('sensitive content'), true);
});

test('unrelated publisher warnings are left unblurred', () => {
  for (const label of ['flashing lights', 'loud audio', 'spoilers', '', null, undefined]) {
    assert.equal(isNsfwWarning(label), false, String(label));
  }
});

test('only image, video and short-video results can be blurred', () => {
  assert.equal(shouldBlurMedia({ kind: 'image', contentWarning: 'nsfw' }), true);
  assert.equal(shouldBlurMedia({ kind: 'video', contentWarning: 'nsfw' }), true);
  assert.equal(shouldBlurMedia({ kind: 'short-video', contentWarning: 'nsfw' }), true);
  assert.equal(shouldBlurMedia({ kind: 'article', contentWarning: 'nsfw' }), false);
  assert.equal(shouldBlurMedia({ kind: 'nsite-root', contentWarning: 'nsfw' }), false);
  assert.equal(shouldBlurMedia({ kind: 'image', contentWarning: null }), false);
});

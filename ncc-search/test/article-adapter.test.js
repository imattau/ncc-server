import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveArticle } from '../src/adapters/article.js';
import { stripMarkdown } from '../src/adapters/markdown.js';

function articleEvent(overrides = {}) {
  return {
    pubkey: 'a'.repeat(64),
    content: 'Hello world.',
    tags: [['d', 'hello-world'], ['title', 'Hello World']],
    ...overrides,
  };
}

test('resolveArticle extracts d/title/summary/image/published_at', () => {
  const event = articleEvent({
    content: 'The body.',
    tags: [
      ['d', 'my-post'],
      ['title', 'My Post'],
      ['summary', 'A short summary'],
      ['image', 'https://example.com/cover.jpg'],
      ['published_at', '1700000000'],
      ['t', 'Bitcoin'],
      ['t', 'nostr'],
    ],
  });

  const resolved = resolveArticle(event);
  assert.equal(resolved.itemId, 'my-post');
  assert.equal(resolved.kind, 'article');
  assert.equal(resolved.title, 'My Post');
  assert.equal(resolved.description, 'A short summary');
  assert.equal(resolved.thumbnailUrl, 'https://example.com/cover.jpg');
  assert.equal(resolved.publishedAt, 1700000000);
  assert.equal(resolved.body, 'The body.');
  assert.equal(resolved.mediaUrl, null);
  assert.deepEqual(resolved.hashtags, ['bitcoin', 'nostr']);
});

test('resolveArticle has no itemId (and is skippable) when the d tag is missing', () => {
  const event = articleEvent({ tags: [['title', 'No identity']] });
  const resolved = resolveArticle(event);
  assert.equal(resolved.itemId, undefined);
});

test('stripMarkdown turns common Markdown syntax into plain text', () => {
  const md = [
    '# Heading',
    '',
    'Some **bold** and *italic* and `code`.',
    '',
    '- item one',
    '- item two',
    '',
    '[a link](https://example.com) and ![an image](https://example.com/x.png)',
    '',
    '```js',
    'const x = 1;',
    '```',
  ].join('\n');

  const text = stripMarkdown(md);
  assert.doesNotMatch(text, /[#*`[\]]/);
  assert.match(text, /Heading/);
  assert.match(text, /bold/);
  assert.match(text, /italic/);
  assert.match(text, /item one/);
  assert.match(text, /a link/);
  assert.match(text, /an image/);
  assert.doesNotMatch(text, /const x = 1/, 'fenced code blocks should be dropped, not indexed verbatim');
});

test('stripMarkdown handles empty input', () => {
  assert.equal(stripMarkdown(''), '');
  assert.equal(stripMarkdown(undefined), '');
});

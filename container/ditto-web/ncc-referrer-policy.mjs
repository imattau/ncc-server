import { readFile, writeFile } from 'node:fs/promises';

const [sourcePath] = process.argv.slice(2);
if (!sourcePath) throw new Error('Pass the Ditto index.html path.');

let source = await readFile(sourcePath, 'utf8');

function replaceOnce(input, before, after, description) {
  const first = input.indexOf(before);
  if (first === -1 || input.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Could not uniquely locate ${description} in index.html.`);
  }
  return input.slice(0, first) + after + input.slice(first + before.length);
}

// Ditto ships `content="no-referrer"` specifically to stop third-party
// embeds (e.g. a linked site) from learning which page/app the viewer was
// on -- a real privacy goal, not a mistake. But "no-referrer" means the
// browser sends NO Referer at all, including on this page's own same-origin
// script/stylesheet requests. ncc-browser's request router depends on that
// same-origin Referer to tell which service a root-relative asset path like
// `/assets/app.js` belongs to when more than one service shares an npub
// (ncc-browser has no other way to know, since a plain Vite build like this
// one only ever emits root-relative paths, not its `/_/<service>/` form) --
// without it, every one of Ditto's own assets falls through to an ambiguous
// fallback and can load as the wrong service entirely. "same-origin" sends
// the Referer only for same-origin requests (covering this page's own
// assets) and nothing for cross-origin ones (covering the original privacy
// goal for embeds) -- the narrowest policy that satisfies both.
source = replaceOnce(
  source,
  '<meta name="referrer" content="no-referrer">',
  '<meta name="referrer" content="same-origin">',
  'the referrer policy meta tag',
);

await writeFile(sourcePath, source);

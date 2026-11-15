import { readFile, writeFile } from 'node:fs/promises';

const [sourcePath] = process.argv.slice(2);
if (!sourcePath) throw new Error('Pass the Ditto useInitialSync.ts path.');

let source = await readFile(sourcePath, 'utf8');

function replaceOnce(input, before, after, description) {
  const first = input.indexOf(before);
  if (first === -1 || input.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Could not uniquely locate ${description} in useInitialSync.ts.`);
  }
  return input.slice(0, first) + after + input.slice(first + before.length);
}

source = replaceOnce(
  source,
  '    const controller = new AbortController();\n    const timeout = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);',
  '    const controller = new AbortController();\n    let cancelled = false;\n    let timeout: ReturnType<typeof setTimeout> | undefined;\n    const timeoutPromise = new Promise<void>((resolve) => {\n      timeout = setTimeout(() => {\n        controller.abort();\n        resolve();\n      }, SYNC_TIMEOUT_MS);\n    });',
  'the timeout controller',
);

source = replaceOnce(
  source,
  '          await Promise.all([',
  '          await Promise.race([\n            Promise.all([',
  'the parallel settings queries',
);

const queriesStart = source.indexOf('          await Promise.race([\n            Promise.all([');
const applyStart = source.indexOf('        // Apply relay list if found', queriesStart);
if (queriesStart === -1 || applyStart === -1) {
  throw new Error('Could not locate the initial sync query block.');
}
const closing = source.lastIndexOf('          ]);', applyStart);
if (closing === -1) throw new Error('Could not locate the initial sync query block end.');
source = source.slice(0, closing) +
  `            ]),
            timeoutPromise.then(() => [[], [], [], []] as [never[], never[], never[], never[]]),
          ]);\n\n        if (cancelled) return;` +
  source.slice(closing + '          ]);'.length);

source = replaceOnce(
  source,
  `            const decrypted = await user.signer.nip44.decrypt(
              user.pubkey,
              settingsEvent.content,
            );`,
  `            const decrypted = await Promise.race([
              user.signer.nip44.decrypt(user.pubkey, settingsEvent.content),
              timeoutPromise.then(() => null),
            ]);`,
  'the signer decrypt',
);

source = replaceOnce(
  source,
  '      clearTimeout(timeout);\n\n      if (foundSettings) {',
  '      if (timeout) clearTimeout(timeout);\n\n      if (cancelled) return;\n\n      if (foundSettings) {',
  'the timer cleanup',
);

source = replaceOnce(
  source,
  '    return () => {\n      clearTimeout(timeout);\n      controller.abort();\n    };',
  '    return () => {\n      cancelled = true;\n      if (timeout) clearTimeout(timeout);\n      controller.abort();\n    };',
  'the effect cleanup',
);

await writeFile(sourcePath, source);

import { readFile, writeFile } from 'node:fs/promises';

const [sourcePath] = process.argv.slice(2);
if (!sourcePath) throw new Error('Pass the Ditto AppRouter.tsx path.');

let source = await readFile(sourcePath, 'utf8');

function replaceOnce(input, before, after, description) {
  const first = input.indexOf(before);
  if (first === -1 || input.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Could not uniquely locate ${description} in Ditto AppRouter.tsx.`);
  }
  return input.slice(0, first) + after + input.slice(first + before.length);
}

const historyLine = '  const [history] = useState(createPushTransitionHistory);';
source = replaceOnce(
  source,
  historyLine,
  `${historyLine}\n  // NCC Browser keeps the service namespace in the secure origin path. Strip that\n  // prefix for Ditto's router while preserving it in the actual NCC page URL.\n  const nccBasename = window.location.protocol === 'ncc:'\n    ? window.location.pathname.match(/^\\/_\\/[^/]+(?=\\/|$)/)?.[0] ?? '/'\n    : '/';`,
  'the router history initialization',
);

const routerTag = '<HistoryRouter history={history} useTransitions={false}>';
source = replaceOnce(
  source,
  routerTag,
  '<HistoryRouter history={history} basename={nccBasename} useTransitions={false}>',
  'the HistoryRouter component',
);

await writeFile(sourcePath, source);

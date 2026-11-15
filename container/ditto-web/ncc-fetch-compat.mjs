import { readFile, writeFile } from 'node:fs/promises';

const [sourcePath] = process.argv.slice(2);
if (!sourcePath) throw new Error('Pass the Ditto AppProvider.tsx path.');

let source = await readFile(sourcePath, 'utf8');

function replaceOnce(input, before, after, description) {
  const first = input.indexOf(before);
  if (first === -1 || input.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Could not uniquely locate ${description} in Ditto AppProvider.tsx.`);
  }
  return input.slice(0, first) + after + input.slice(first + before.length);
}

source = replaceOnce(
  source,
  '  // Cache the loaded SVG blob URL across renders.\n  const svgBlobUrlRef = useRef<string | null>(null);',
  '  // Keep an Image element so custom NCC origins do not need Fetch API support.\n  const svgImageRef = useRef<HTMLImageElement | null>(null);',
  'the favicon image cache',
);

source = replaceOnce(
  source,
  `      // Load the SVG once and cache it as a blob URL for canvas use.
      if (!svgBlobUrlRef.current) {
        try {
          const resp = await fetch('/logo.svg');
          const text = await resp.text();
          const blob = new Blob([text], { type: 'image/svg+xml' });
          svgBlobUrlRef.current = URL.createObjectURL(blob);
        } catch {
          return; // Silently fail if SVG can't be loaded
        }
      }

      if (cancelled) return;

      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const img = new Image();
      img.src = svgBlobUrlRef.current!;

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject();
      });`,
  `      // Image loading goes through the page's normal resource path, which is
      // supported by NCC Browser even where Fetch API does not accept ncc://.
      if (!svgImageRef.current) {
        const image = new Image();
        try {
          await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject();
            image.src = '/logo.svg';
          });
          svgImageRef.current = image;
        } catch {
          return; // Silently fail if SVG can't be loaded
        }
      }

      if (cancelled) return;

      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;`,
  'the favicon SVG fetch',
);

source = replaceOnce(
  source,
  'ctx.drawImage(img, 0, 0, size, size);',
  'ctx.drawImage(svgImageRef.current!, 0, 0, size, size);',
  'the favicon mask draw',
);

await writeFile(sourcePath, source);

// The backend's FTS5 snippet() wraps a match in plain "[" "]" markers, never
// HTML (see ncc-search/src/store.js's `snippet(services_fts, 5, '[', ']', …)`
// call) -- so this only ever splits on that literal delimiter and renders
// plain text nodes through JSX. It never uses dangerouslySetInnerHTML, even
// though the underlying text ultimately comes from relay-published event
// data that this app does not otherwise trust.
export function Snippet({ text }: { text: string }) {
  const parts = text.split(/\[([^\]]*)\]/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-yellow-200 px-0.5 text-inherit dark:bg-yellow-500/40">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

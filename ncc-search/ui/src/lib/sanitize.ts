// Only http(s) links are ever rendered as a clickable href. NCC-02/NCC-05
// endpoints can legitimately be wss://, onion://, tcp:// too, but those
// aren't things a browser can navigate to directly, and this never trusts
// an unvalidated scheme from relay-published data either way (see
// test-app/AGENTS.md's XSS guidance: sanitize every event-sourced URL
// before using it as href).
export function sanitizeHref(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch {
    // not a parseable absolute URL -- fall through to null
  }
  return null;
}

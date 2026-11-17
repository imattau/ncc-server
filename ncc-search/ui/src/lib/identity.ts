// Kept in one place because both the result row's meta line and the article
// preview's byline show the same identity, at different widths.
export function truncateIdentity(value: string) {
  return value.length > 24 ? `${value.slice(0, 16)}…${value.slice(-6)}` : value;
}

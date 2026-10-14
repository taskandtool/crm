// A phone as a match key: its last ten digits, an extension left off, so
// "(555) 010-2030" and "+1 555 010 2030" agree. Under seven digits is no key.
// The SQL twin is sql.ts phoneKeyOf. Phone matches only where one side has
// no email: two emails on one household phone stay two people.

const EXTENSION = /\s*(?:ext|extension|x|#)[.:\s]*[0-9]+\s*$/i;

export function phoneKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = v.slice(0, 100).replace(EXTENSION, "").replace(/[^0-9]/g, "");
  return d.length >= 7 ? d.slice(-10) : null;
}

/** A phone as typed, trimmed and bounded; null when empty. */
export function cleanPhone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ").slice(0, 40);
  return s || null;
}

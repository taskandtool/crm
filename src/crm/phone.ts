// A phone number as a match key: its digits, the last ten of them. People
// write one number many ways ("(555) 010-2030", "+1 555 010 2030",
// "5550102030"), and the last ten digits agree across a country code, a trunk
// zero or punctuation. An extension at the end ("x12", "ext. 12", "#12") is
// not part of the number: left in, its digits would push the real ones out
// of the last ten. Under seven digits is not a phone number worth matching
// on. The same expression is in SQL (schema.sql's customers_phone_match
// index, and every query that matches by phone):
//
//   right(regexp_replace(regexp_replace(phone, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10)
//
// (POSIX classes rather than \s and \d: a backslash in a tagged template's
// text does not survive to the SQL.)
//
// Phone matching is the fallback after email, and only between records where
// one side has no email: two people with different emails who share a
// household phone stay two people.

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

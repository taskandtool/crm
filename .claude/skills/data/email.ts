// Email is how apps recognise one person across the project: every
// table that names a person has an `email citext` column, and the CRM joins on
// it. citext makes the comparison case-blind; this trims and checks the shape
// before anything is stored, so " Ann@Example.com " and "ann@example.com" are
// one person.

// A plain address only: no display names, quotes, brackets, commas or
// control characters, which turn a stored address into a header or a list.
const SHAPE = /^[^@\s<>()[\]\\,;:"\u0000-\u001f\u007f]+@[^@\s<>()[\]\\,;:"\u0000-\u001f\u007f]+\.[^@\s<>()[\]\\,;:"\u0000-\u001f\u007f.]+[^@\s<>()[\]\\,;:"\u0000-\u001f\u007f]*$/;

/** The address to store, or null when it is not an email address. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  return s.length <= 254 && SHAPE.test(s) ? s : null;
}

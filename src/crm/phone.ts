// A phone as typed, cleaned for storing. Its match key is the customers
// skill's phoneKey (customer.ts; the SQL twin is sql.ts phoneKeyOf). Phone
// matches only where one side has no email: two emails on one household
// phone stay two people.

/** A phone as typed, trimmed and bounded; null when empty. */
export function cleanPhone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ").slice(0, 40);
  return s || null;
}

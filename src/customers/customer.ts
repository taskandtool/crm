// The customer for a person who got in touch, found or made the way the CRM's
// "Add as customer" makes one, so a note logged on their submission lands on
// the record the CRM shows. Edge-safe.
//
//   const c = await customerByEmail(db, sub.email);              // null until someone notes them
//   const made = await customerFor(db, sub, user);               // on the first note
//   await addNote(db, made.id, { kind: "call", body, at: wallTime(at), timeZone }, user);
import type { Db } from "../data/db";

export type CustomerRef = { id: string; name: string; stage: string };

/** The stage a new customer starts in when the CRM has not set up its statuses: its default first one. */
const DEFAULT_STAGE = "lead";

/** The live customer with this email, or one that goes by it after a merge; null when there is none. */
export async function customerByEmail(db: Db, email: string): Promise<CustomerRef | null> {
  const [c] = await db.sql<CustomerRef>`
    select id::text as id, name, stage from customers
    where merged_into is null and (email = ${email}::citext or ${email.toLowerCase()} = any(other_emails))
    order by (email = ${email}::citext) desc, id limit 1`;
  return c ?? null;
}

/**
 * Their customer, made from the submission when there is none: its name,
 * email and phone, the form's title as where they came from, first contact
 * when it came in, and the CRM's first open status (its default "lead" when
 * the CRM has not set its statuses up yet). Two notes at once make one.
 */
export async function customerFor(
  db: Db,
  sub: { email: string; name: string | null; phone: string | null; created_at: Date; source: string },
  user: string,
): Promise<CustomerRef> {
  const found = await customerByEmail(db, sub.email);
  if (found) return found;
  const [{ stages }] = await db.sql<{ stages: boolean }>`select to_regclass('pipeline_stages') is not null as stages`;
  const [first] = stages
    ? await db.sql<{ key: string }>`select key from pipeline_stages where not archived and kind = 'open' order by position, key limit 1`
    : [];
  const name = (sub.name?.trim() || sub.email).slice(0, 200);
  // The CRM's cleanPhone: trimmed, spaces collapsed, at most 40 characters.
  const phone = sub.phone?.trim().replace(/\s+/g, " ").slice(0, 40) || null;
  await db.sql`
    insert into customers (name, email, phone, stage, source, last_contact_at, created_by, updated_by)
    values (${name}, ${sub.email}::citext, ${phone}, ${first?.key ?? DEFAULT_STAGE}, ${sub.source}, ${sub.created_at}, ${user}, ${user})
    on conflict (email) where email is not null do nothing`;
  return (await customerByEmail(db, sub.email))!;
}

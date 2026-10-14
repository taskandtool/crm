// The customer for a person who got in touch, found or made at the moment
// they do: a form submission, an online booking, the first note about them.
// Every app that writes those calls savePerson, so the person is a customer
// before anyone looks, and saveLead for the enquiry itself. Edge-safe.
//
//   const c = await customerByEmail(db, sub.email);                      // null when there is none
//   const saved = await savePerson(db, { name, email, phone, source: "Get a quote", at, answers }, null);
import { q, type Db, type Query } from "../data/db";
import { normalizeEmail } from "../data/email";

export type CustomerRef = { id: string; name: string; stage: string };

/** The stage a new customer starts in when the CRM has not set up its statuses: its default first one. */
const DEFAULT_STAGE = "lead";

/** The customer with this email (not one merged away), or one that goes by it after a merge; null when there is none. */
export async function customerByEmail(db: Db, email: string): Promise<CustomerRef | null> {
  const [c] = await db.sql<CustomerRef>`
    select id::text as id, name, stage from customers
    where merged_into is null and (email = ${email}::citext or ${email.toLowerCase()} = any(other_emails))
    order by (email = ${email}::citext) desc, id limit 1`;
  return c ?? null;
}

/**
 * A phone as a match key: its last ten digits, an extension left off, so
 * "(555) 010-2030" and "+1 555 010 2030 ext 4" agree; under seven digits is
 * no key. The CRM's sql.ts phoneKeyOf is its SQL twin.
 */
export function phoneKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = v.slice(0, 100).replace(/\s*(?:ext|extension|x|#)[.:\s]*[0-9]+\s*$/i, "").replace(/[^0-9]/g, "");
  return d.length >= 7 ? d.slice(-10) : null;
}

export type Person = {
  name: string | null;
  email: string | null;
  phone: string | null;
  /** Where they came from, in words: the form's title, "Booking: Estimate visit". */
  source: string;
  /** When they got in touch: first contact on a new record. A string as a driver may return it. */
  at: Date | string;
  /** What they answered: `address`, `company` and any custom field's key fill those. */
  answers?: Record<string, unknown> | null;
};

/**
 * Their customer, as HubSpot makes a contact of a form fill: found by email
 * (one gained in a merge too), else by phone where either side has no email
 * (two emails on one household phone stay two people), never by name; made
 * when there is none, in the CRM's first open status (`lead` before it has
 * any). Their address, company and custom fields fill from `answers`, only
 * where the record has none. Null when there is no email or phone to know
 * them by, or the project has no customers table.
 *
 * Two saves of one person at once (a double submit, a booking and its form)
 * make one record: a lock on each key first, the CRM's createCustomer's
 * locks, then a look and an insert in one statement.
 */
export async function savePerson(db: Db, p: Person, user: string | null): Promise<CustomerRef | null> {
  const email = normalizeEmail(p.email);
  const key = phoneKey(p.phone);
  if (!email && !key) return null;
  const [has] = await db.sql<{ customers: boolean; stages: boolean; fields: boolean }>`
    select to_regclass('customers') is not null as customers, to_regclass('pipeline_stages') is not null as stages,
           to_regclass('customer_fields') is not null as fields`;
  if (!has.customers) return null;
  const [first] = has.stages
    ? await db.sql<{ key: string }>`select key from pipeline_stages where not archived and kind = 'open' order by position, key limit 1`
    : [];
  const defs = has.fields ? await db.sql<FieldDef>`select key, label, type, options from customer_fields order by position, key` : [];
  const a = p.answers && typeof p.answers === "object" && !Array.isArray(p.answers) ? p.answers : {};
  const address = text(a.address, 500);
  const company = text(a.company, 200);
  const fields = JSON.stringify(answerFields(defs, a));
  const name = (p.name?.trim() || email || p.phone?.trim() || "Unknown").slice(0, 200);
  // The CRM's cleanPhone: trimmed, spaces collapsed, at most 40 characters.
  const phone = p.phone?.trim().replace(/\s+/g, " ").slice(0, 40) || null;
  const locks: Query[] = [email && `email:${email}`, key && `phone:${key}`]
    .filter((l): l is string => !!l)
    .map((l) => q`select pg_advisory_xact_lock(hashtext(${"crm.customer." + l}::text))`);
  const results = await db.transaction([
    ...locks,
    q`with m as (
        select c.id from customers c
        where (${email}::citext is not null and (c.email = ${email}::citext or c.other_emails @> array[${email}::text]))
           -- The phone key exactly as schema.sql's customers_phone_match index has it, so the index answers.
           or (${key}::text is not null and (c.email is null or ${email}::citext is null)
               and right(regexp_replace(regexp_replace(c.phone, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10) = ${key}::text)
        order by (${email}::citext is not null and c.email = ${email}::citext) desc, c.archived_at nulls first, c.id
        limit 1),
      ins as (
        insert into customers (name, email, phone, company, address, stage, source, fields, last_contact_at, created_by, updated_by)
        select ${name}::text, ${email}::citext, ${phone}::text, ${company}::text, ${address}::text, ${first?.key ?? DEFAULT_STAGE}::text, ${p.source}::text,
               ${fields}::jsonb, ${new Date(p.at).toISOString()}::timestamptz, ${user}::citext, ${user}::citext
        where not exists (select 1 from m)
        on conflict (email) where email is not null do nothing
        returning id),
      filled as (
        update customers c set
          phone = coalesce(nullif(c.phone, ''), ${phone}::text),
          company = coalesce(nullif(c.company, ''), ${company}::text),
          address = coalesce(nullif(c.address, ''), ${address}::text),
          fields = c.fields || coalesce((
            select jsonb_object_agg(e.key, e.value) from jsonb_each(${fields}::jsonb) e
            where coalesce(c.fields ->> e.key, '') = ''), '{}'::jsonb),
          updated_at = now()
        where c.id = (select id from m)
          and ((nullif(c.phone, '') is null and ${phone}::text is not null)
            or (nullif(c.company, '') is null and ${company}::text is not null)
            or (nullif(c.address, '') is null and ${address}::text is not null)
            or exists (select 1 from jsonb_each(${fields}::jsonb) e where coalesce(c.fields ->> e.key, '') = ''))
        returning c.id)
      select id::text as id from ins union all select id::text as id from m`,
  ]);
  const [row] = results[results.length - 1] as { id: string }[];
  // Only an insert that yielded to the email index (a writer without the lock) finds nothing: look again.
  const id = row?.id ?? (email ? (await customerByEmail(db, email))?.id : undefined);
  if (!id) return null;
  const [c] = await db.sql<CustomerRef>`select id::text as id, name, stage from customers where id = ${id}::bigint`;
  return c ?? null;
}

type FieldDef = { key: string; label: string; type: string; options: string[] };

/**
 * The custom fields a form's answers give, read as the CRM's customer form
 * reads them (its src/crm/fields.ts readFields, strict): a number that is
 * one, a YYYY-MM-DD date, one of a select's options, an email address;
 * anything else is left out.
 */
export function answerFields(defs: FieldDef[], answers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of defs) {
    if (!Object.prototype.hasOwnProperty.call(answers, f.key)) continue;
    const raw = answers[f.key];
    const s = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
    if (!s) continue;
    if (f.type === "number") {
      const n = Number(s.replace(/[, ]/g, ""));
      if (Number.isFinite(n)) out[f.key] = n;
    } else if (f.type === "date") {
      if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"))) out[f.key] = s;
    } else if (f.type === "select") {
      const o = f.options.find((x) => x.toLowerCase() === s.toLowerCase());
      if (o) out[f.key] = o;
    } else if (f.type === "email") {
      const e = normalizeEmail(s);
      if (e) out[f.key] = e;
    } else if (f.type === "phone") {
      out[f.key] = s.replace(/\s+/g, " ").slice(0, 40);
    } else {
      out[f.key] = s.slice(0, 2000);
    }
  }
  return out;
}

export type LeadSource = "form" | "booking" | "phone" | "walk_in" | "referral" | "other";

/**
 * A lead for a customer: one enquiry, as Pipedrive's leads and Jobber's
 * requests are, from what came in (a form submission, an online booking)
 * or added by the team. Once per submission or booking: a second call for
 * the same one returns the first. Null when the project has no leads table.
 */
export async function saveLead(
  db: Db,
  l: { customerId: string; source: LeadSource; title: string; notes?: string | null; submissionId?: string | null; bookingId?: string | null; owner?: string | null; at?: Date | string },
  user: string | null,
): Promise<string | null> {
  const [has] = await db.sql<{ leads: boolean }>`select to_regclass('leads') is not null as leads`;
  if (!has.leads) return null;
  const at = l.at ? new Date(l.at).toISOString() : new Date().toISOString();
  const [row] = await db.sql<{ id: string }>`
    with ins as (
      insert into leads (customer_id, source, submission_id, booking_id, title, notes, owner, created_by, updated_by, created_at, updated_at)
      values (${l.customerId}::bigint, ${l.source}, ${l.submissionId ?? null}::bigint, ${l.bookingId ?? null}::bigint, ${l.title.trim().slice(0, 200) || "Enquiry"},
              ${l.notes?.trim().slice(0, 10000) || null}, ${l.owner ?? null}::citext, ${user}::citext, ${user}::citext, ${at}::timestamptz, ${at}::timestamptz)
      on conflict do nothing
      returning id)
    select id::text as id from ins
    union all
    select id::text as id from leads
    where (${l.submissionId ?? null}::bigint is not null and submission_id = ${l.submissionId ?? null}::bigint)
       or (${l.bookingId ?? null}::bigint is not null and booking_id = ${l.bookingId ?? null}::bigint)
    limit 1`;
  return row?.id ?? null;
}

/** A trimmed answer, bounded; null when empty or not text. */
function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

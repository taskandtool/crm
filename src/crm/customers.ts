// Every query on `customers`, named. Routes, scripts and tests all go
// through here. A person is their email (citext, unique when present); a
// customer without one is matched by phone (phone.ts). Customers are
// archived, never deleted, from the CRM.
import { q, type Db, type Query } from "../data/db";
import { normalizeEmail } from "../data/email";
import { readCursor, type Cursor, type Keyed } from "../admin/keyset";
import { likePattern } from "../admin/query";
import { sameAs } from "./people";
import { phoneKey, savePerson } from "../customers/customer";
import { BOOKING_PAGE, saveSubmitter } from "../forms/store";
import { cleanPhone } from "./phone";
import { byEmail, isCustomer, NOTHING_PLANNED, phoneKeyOf, spliced } from "./sql";
import { present as presentTables } from "./tables";

const texts = spliced({ nothing_planned: NOTHING_PLANNED, phone_key: phoneKeyOf("c.phone") });

export type Customer = Keyed & {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  address: string | null;
  stage: string;
  source: string | null;
  tags: string[];
  owner: string | null;
  fields: Record<string, unknown>;
  notes: string | null;
  last_contact_at: Date | null;
  archived_at: Date | null;
  /** Addresses they also go by, from a merge. */
  other_emails: string[];
  /** On a record merged into another: that one's id. */
  merged_into: string | null;
  /** Don't text (the phone skill's customers.texts_off): as if they had said STOP. */
  texts_off?: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export type NewCustomer = {
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  address?: string | null;
  stage: string;
  source?: string | null;
  tags?: string[];
  owner?: string | null;
  fields?: Record<string, unknown>;
  notes?: string | null;
  last_contact_at?: Date | string | null;
};

/** `unplanned`: only the ones still in play with no next step (tasks.ts nothingPlanned says the same, quietest first). */
export type ListFilter = { q: string | null; stage: string | null; tag: string | null; owner: string | null; archived: boolean; unplanned: boolean };
export const NO_FILTER: ListFilter = { q: null, stage: null, tag: null, owner: null, archived: false, unplanned: false };

// A list cursor's time: fixed-width UTC text with microseconds, so it casts
// back to the exact instant (admin/keyset.ts has the microsecond rule).
export const K_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** True when `k` is K_SHAPE and a real instant ("2026-02-30" is neither to Postgres). */
export function validK(k: string): boolean {
  if (!K_SHAPE.test(k)) return false;
  const d = new Date(k);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 19) === k.slice(0, 19);
}

/** The list's `after`, or null for a cursor that was not made here (so a tampered one is the first page, not a 500). */
export function readListCursor(s: string | null | undefined): Cursor | null {
  const c = readCursor(s);
  return c && validK(c.k) ? c : null;
}

/**
 * One page plus one row, most recent contact first (one never contacted by
 * when they were added, so a new lead is near the top), as the Last contact
 * column reads; after the cursor.
 */
export function listPage(db: Db, f: ListFilter, after: Cursor | null, size: number): Promise<Customer[]> {
  const pat = likePattern(f.q);
  // "555 0102" finds "(555) 010-2" too: a search with four or more digits and
  // nothing but phone punctuation also matches the stored digits.
  const digits = f.q && /^[\d\s()+.-]+$/.test(f.q) ? f.q.replace(/\D/g, "") : "";
  const digitPat = digits.length >= 4 ? `%${digits}%` : null;
  return texts.sql(db)<Customer>`
    select c.*, to_char(coalesce(c.last_contact_at, c.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as k
    from customers c
    where (${pat}::text is null or c.name ilike ${pat} or c.email::text ilike ${pat} or c.phone ilike ${pat} or c.company ilike ${pat}
           or (${digitPat}::text is not null and regexp_replace(c.phone, '[^0-9]', '', 'g') like ${digitPat}))
      and (${f.stage}::text is null or c.stage = ${f.stage})
      and (${f.tag}::text is null or c.tags @> array[${f.tag}::text])
      and (${f.owner}::text is null or c.owner = any(${f.owner ? sameAs(f.owner) : null}::citext[]))
      and ((c.archived_at is not null) = ${f.archived}::boolean)
      and (not ${f.unplanned}::boolean or ({nothing_planned}))
      and (${after?.k ?? null}::timestamptz is null
           or (coalesce(c.last_contact_at, c.created_at), c.id) < (${after?.k ?? null}::timestamptz, ${after?.id ?? null}::bigint))
    order by coalesce(c.last_contact_at, c.created_at) desc, c.id desc
    limit ${size + 1}`;
}

/** Everyone active, by name: what a picker offers (New task). */
export function customerChoices(db: Db, limit = 2000): Promise<{ id: string; name: string; email: string | null }[]> {
  return db.sql`
    select id::text as id, name, email::text as email from customers
    where archived_at is null and merged_into is null
    order by lower(name), id limit ${limit}`;
}

export async function getCustomer(db: Db, id: string): Promise<Customer | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [c] = await db.sql<Customer>`select c.*, c.updated_at::text as k from customers c where c.id = ${id}::bigint`;
  return c ?? null;
}

/**
 * The customer this email or phone belongs to: by email (theirs, or one
 * they also go by after a merge) first; then by
 * phone, but only where one side has no email (two different emails are two
 * people, even on one household phone). Active customers before archived.
 */
export async function findMatch(db: Db, emailIn: unknown, phoneIn: unknown): Promise<Customer | null> {
  const email = normalizeEmail(emailIn);
  const key = phoneKey(phoneIn);
  if (!email && !key) return null;
  const [c] = await texts.sql(db)<Customer>`
    select * from (
      select c.*, c.updated_at::text as k, 0 as rank from customers c
      where ${email}::citext is not null and (c.email = ${email}::citext or c.other_emails @> array[${email}::text])
      union all
      select c.*, c.updated_at::text as k, 1 as rank from customers c
      where ${key}::text is not null and {phone_key} = ${key}
        and (c.email is null or ${email}::citext is null)
    ) m
    order by rank, archived_at nulls first, id::bigint
    limit 1`;
  return c ?? null;
}

/**
 * A customer by id ("42" or "#42"), email or phone: the scripts' `<who>`. A
 * string of digits is an id when a customer has it, else a phone number.
 */
export async function findCustomer(db: Db, whoIn: string): Promise<Customer | null> {
  const who = whoIn.trim().replace(/^#(?=\d)/, "");
  if (/^\d{1,18}$/.test(who)) {
    const byId = await getCustomer(db, who);
    if (byId || whoIn.trim().startsWith("#")) return byId;
  }
  const email = normalizeEmail(who);
  if (email) return findMatch(db, email, null);
  const key = phoneKey(who);
  return key ? findMatch(db, null, who) : null;
}

/**
 * Create a customer unless one already has this email or phone (never by
 * name: two John Smiths are two people). Returns the customer and whether it
 * is new.
 *
 * Two requests racing on one person (a double click, the page and a script)
 * both get the one row. A unique index covers only the email, so the
 * transaction first takes an advisory lock on each key it could match on
 * (email, then phone: one order everywhere, and the customers skill's
 * savePerson takes the same locks), then looks and inserts in one statement.
 * The second request waits for the first to commit and finds it.
 */
export async function createCustomer(
  db: Db,
  input: NewCustomer,
  user: string,
): Promise<{ customer: Customer; created: boolean }> {
  const email = normalizeEmail(input.email);
  const phone = cleanPhone(input.phone);
  const key = phoneKey(phone);
  const locks = [email && `email:${email}`, key && `phone:${key}`].filter((l): l is string => !!l);
  const statements: Query[] = locks.map((l) => q`select pg_advisory_xact_lock(hashtext(${"crm.customer." + l}::text))`);
  statements.push(texts.q`
    with m as (
      select id from (
        select c.id, c.archived_at, 0 as rank from customers c
        where ${email}::citext is not null and (c.email = ${email}::citext or c.other_emails @> array[${email}::text])
        union all
        select c.id, c.archived_at, 1 as rank from customers c
        where ${key}::text is not null
          and {phone_key} = ${key}
          and (c.email is null or ${email}::citext is null)
      ) x
      order by rank, archived_at nulls first, id
      limit 1),
    ins as (
      insert into customers (name, email, phone, company, address, stage, source, tags, owner, fields, notes, last_contact_at, created_by, updated_by)
      select ${input.name}::text, ${email}::citext, ${phone}::text, ${input.company ?? null}::text, ${input.address ?? null}::text, ${input.stage}::text, ${input.source ?? null}::text,
             ${input.tags ?? []}::text[], ${input.owner ?? null}::citext, ${JSON.stringify(input.fields ?? {})}::jsonb, ${input.notes ?? null}::text,
             ${input.last_contact_at ?? null}::timestamptz, ${user}::citext, ${user}::citext
      where not exists (select 1 from m)
      on conflict (email) where email is not null do nothing
      returning *)
    select ins.*, ins.updated_at::text as k, true as created from ins
    union all
    select c.*, c.updated_at::text as k, false as created from customers c where c.id = (select id from m)`);
  const results = await db.transaction(statements);
  const [row] = results[results.length - 1] as (Customer & { created: boolean })[];
  if (row) {
    const { created, ...customer } = row;
    return { customer, created };
  }
  // Only a writer that takes no lock (an import committing this email
  // meanwhile) gets here: the insert yielded to the unique index.
  const existing = await findMatch(db, email, phone);
  if (!existing) throw new Error("createCustomer: the insert yielded to a row that cannot be found");
  return { customer: existing, created: false };
}

export type Details = {
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  address: string | null;
  source: string | null;
  tags: string[];
  owner: string | null;
  notes: string | null;
  /** Custom fields to set; keys not named here are kept as they are. */
  fields: Record<string, unknown>;
  /** Custom fields to clear. */
  unset: string[];
};

/** Save a customer's details. Refuses an email another customer already has. */
export async function saveDetails(db: Db, id: string, d: Details, user: string): Promise<{ ok: true; customer: Customer } | { ok: false; reason: "missing" | "email-taken" }> {
  const email = normalizeEmail(d.email);
  try {
    // Their events carry their name, email and phone (the booking skill's confirmations and the invoices read them there): changed with them.
    const [c] = await db.sql<Customer>`
      with c as (
        update customers set
          name = ${d.name}, email = ${email}::citext, phone = ${cleanPhone(d.phone)}, company = ${d.company}, address = ${d.address},
          source = ${d.source}, tags = ${d.tags}::text[], owner = ${d.owner}::citext, notes = ${d.notes},
          fields = (fields - ${d.unset}::text[]) || ${JSON.stringify(d.fields)}::jsonb,
          updated_at = now(), updated_by = ${user}
        where id = ${id}::bigint
        returning *),
      e as (update bookings b set name = c.name, email = c.email, phone = c.phone from c where b.customer_id = c.id)
      select *, updated_at::text as k from c`;
    return c ? { ok: true, customer: c } : { ok: false, reason: "missing" };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return { ok: false, reason: "email-taken" };
    throw e;
  }
}

/** Move a customer to an active status. Null when either is missing. */
export async function setStage(db: Db, id: string, stage: string, user: string): Promise<Customer | null> {
  const [c] = await db.sql<Customer>`
    update customers set stage = ${stage}, updated_at = now(), updated_by = ${user}
    where id = ${id}::bigint and exists (select 1 from pipeline_stages where key = ${stage} and not archived)
    returning *, updated_at::text as k`;
  return c ?? null;
}

export async function setArchived(db: Db, id: string, archived: boolean, user: string): Promise<Customer | null> {
  const [c] = await db.sql<Customer>`
    update customers set archived_at = case when ${archived}::boolean then coalesce(archived_at, now()) end,
      updated_at = now(), updated_by = ${user}
    where id = ${id}::bigint
    returning *, updated_at::text as k`;
  return c ?? null;
}

/** Add and remove tags; a tag is kept once, compared case-blind, in its first spelling. */
export async function retag(db: Db, id: string, add: string[], remove: string[], user: string): Promise<Customer | null> {
  const [c] = await db.sql<Customer>`
    update customers set
      tags = coalesce((
        select array_agg(t order by first) from (
          select (array_agg(t order by o))[1] as t, min(o) as first from unnest(tags || ${add}::text[]) with ordinality as x(t, o)
          where not (lower(t) = any(${remove.map((r) => r.toLowerCase())}::text[]))
          group by lower(t)) d), '{}'),
      updated_at = now(), updated_by = ${user}
    where id = ${id}::bigint
    returning *, updated_at::text as k`;
  return c ?? null;
}

/** Set some details and custom fields (and clear `unset`), leaving the rest. For the scripts. */
export async function patchCustomer(db: Db, id: string, patch: Partial<Details>, user: string) {
  const c = await getCustomer(db, id);
  if (!c) return { ok: false as const, reason: "missing" as const };
  return saveDetails(
    db,
    id,
    {
      name: patch.name ?? c.name,
      email: patch.email !== undefined ? patch.email : c.email,
      phone: patch.phone !== undefined ? patch.phone : c.phone,
      company: patch.company !== undefined ? patch.company : c.company,
      address: patch.address !== undefined ? patch.address : c.address,
      source: patch.source !== undefined ? patch.source : c.source,
      tags: patch.tags ?? c.tags,
      owner: patch.owner !== undefined ? patch.owner : c.owner,
      notes: patch.notes !== undefined ? patch.notes : c.notes,
      fields: patch.fields ?? {},
      unset: patch.unset ?? [],
    },
    user,
  );
}

/** The tags and owners in use, for filters and suggestions. */
export async function facets(db: Db): Promise<{ tags: string[]; owners: string[] }> {
  const [tags, owners] = await Promise.all([
    db.sql<{ t: string }>`select distinct unnest(tags) as t from customers where archived_at is null order by 1 limit 200`,
    db.sql<{ o: string }>`select distinct owner::text as o from customers where owner is not null order by 1 limit 200`,
  ]);
  return { tags: tags.map((r) => r.t), owners: owners.map((r) => r.o) };
}

/**
 * A quote or an invoice that went to this address counts as contact: the
 * customer it belongs to (theirs, or one they also go by) has their last
 * contact moved to now, never back. Nobody by that address: nothing.
 */
export async function sentTo(db: Db, emailIn: string, user: string): Promise<void> {
  const email = normalizeEmail(emailIn);
  if (!email) return;
  await db.sql`
    update customers set last_contact_at = greatest(last_contact_at, now()), updated_at = now(), updated_by = ${user}
    where email = ${email}::citext or other_emails @> array[${email}::text]`;
}

// Who each row is: the one rule (sql.ts), by email, else by phone.
const { sql: everyoneSql } = spliced({ sub_is: isCustomer("s"), booking_is: isCustomer("b"), pay_email: byEmail("p") });

/**
 * Everyone already in the project's tables who is not a customer yet, saved
 * through the customers skill's savePerson, the way the forms and booking
 * skills save each person as they arrive: what came in before they did.
 * Every submission (not spam),
 * booking and payment is looked at, none left for later. Run by setup at
 * start and deploy, never per request. Returns how many it saved.
 */
export async function saveEveryone(db: Db): Promise<number> {
  const p = await presentTables(db);
  const count = async () => (await db.sql<{ n: number }>`select count(*)::int as n from customers`)[0].n;
  const before = await count();
  if (p.submissions) {
    const subs = await everyoneSql(db)<{ id: string }>`
      select s.id::text as id from submissions s
      where s.status <> 'spam' and s.form_key <> ${BOOKING_PAGE.key} and (s.email is not null or s.phone is not null)
        and not exists (select 1 from customers c where {sub_is})
      order by s.created_at, s.id`;
    for (const s of subs) await saveSubmitter(db, s.id);
  }
  const bookings = await everyoneSql(db)<{ name: string | null; email: string | null; phone: string | null; created_at: Date; type_name: string | null; address: string | null }>`
    select b.name, b.email::text as email, b.phone, b.created_at, t.name as type_name,
           case when b.location_kind = 'their_place' then b.location end as address
    from bookings b left join booking_types t on t.id = b.type_id
    where (b.email is not null or b.phone is not null) and not exists (select 1 from customers c where {booking_is})
    order by b.created_at, b.id`;
  for (const b of bookings) {
    await savePerson(db, { name: b.name, email: b.email, phone: b.phone, source: b.type_name ? `Booking: ${b.type_name}` : "Booking", at: b.created_at, answers: b.address ? { address: b.address } : null }, null);
  }
  if (p.payments) {
    const paid = await everyoneSql(db)<{ name: string | null; email: string; created_at: Date }>`
      select p.name, p.email::text as email, p.created_at from payments p
      where p.status in ('paid', 'refunded', 'partially_refunded') and p.email is not null
        and not exists (select 1 from customers c where {pay_email})
      order by p.created_at, p.id`;
    for (const r of paid) await savePerson(db, { name: r.name, email: r.email, phone: null, source: "Payment", at: r.created_at }, null);
  }
  return (await count()) - before;
}

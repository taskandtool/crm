// Merging two records of one person. The rest of the project finds a
// customer by email (submissions, bookings, payments, quotes, invoices keep
// the address they came in with), so the record kept takes the other's email
// as one it also goes by (customers.other_emails), and everything those
// tables hold under it is still theirs. The record kept also takes the
// other's notes, jobs, deals and follow-ups, fills its blanks from the
// other's details (its own values win), and gains its tags. The other is
// archived with merged_into set and its email and phone cleared, so nothing
// matches it again; a note on the kept record says what was merged. One
// transaction; not undone.
import { q, type Db } from "../data/db";
import { getCustomer, type Customer } from "./customers";

export type MergePreview = {
  keep: Customer;
  other: Customer;
  moves: { notes: number; visits: number; deals: number; followUps: number };
  /** The details the kept record gains, by name ("phone", "company"...). */
  fills: string[];
};

export type MergeResult = { ok: true; customer: Customer } | { ok: false; reason: "same" | "missing" | "merged" };

const ID = /^\d{1,18}$/;

/** What merging `otherId` into `keepId` would do; null when either is missing. */
export async function mergePreview(db: Db, keepId: string, otherId: string): Promise<MergePreview | null> {
  if (!ID.test(keepId) || !ID.test(otherId)) return null;
  const [keep, other] = await Promise.all([getCustomer(db, keepId), getCustomer(db, otherId)]);
  if (!keep || !other) return null;
  const [n] = await db.sql<{ notes: number; visits: number; deals: number; follow_ups: number }>`
    select (select count(*) from customer_notes where customer_id = ${otherId}::bigint)::int as notes,
           (select count(*) from customer_visits where customer_id = ${otherId}::bigint)::int as visits,
           (select count(*) from deals where customer_id = ${otherId}::bigint)::int as deals,
           (select count(*) from follow_ups where customer_id = ${otherId}::bigint)::int as follow_ups`;
  const blank = (v: unknown) => v === null || v === undefined || v === "";
  const fills: string[] = (["phone", "company", "address", "source", "owner"] as const).filter((k) => blank(keep[k]) && !blank(other[k]));
  for (const [k, v] of Object.entries(other.fields ?? {})) if (blank(keep.fields?.[k]) && !blank(v)) fills.push(k);
  if (other.email && other.email.toLowerCase() !== keep.email?.toLowerCase()) fills.push(`also goes by ${other.email}`);
  return { keep, other, moves: { notes: n.notes, visits: n.visits, deals: n.deals, followUps: n.follow_ups }, fills };
}

/** Merge `otherId` into `keepId`. */
export async function mergeCustomers(db: Db, keepId: string, otherId: string, user: string): Promise<MergeResult> {
  if (!ID.test(keepId) || !ID.test(otherId)) return { ok: false, reason: "missing" };
  if (keepId === otherId) return { ok: false, reason: "same" };
  // Both locked, lower id first, so two merges of the same pair cannot cross.
  const lock = q`select id from customers where id in (${keepId}::bigint, ${otherId}::bigint) order by id for update`;
  // Every statement after the lock checks the pair is still mergeable, so a
  // merge that lost a race changes nothing.
  const keep = keepId;
  const other = otherId;
  const out = await db.transaction([
    lock,
    // The kept record first, while the other still holds its details.
    q`update customers k set
        phone = coalesce(nullif(k.phone, ''), o.phone),
        company = coalesce(nullif(k.company, ''), o.company),
        address = coalesce(nullif(k.address, ''), o.address),
        source = coalesce(nullif(k.source, ''), o.source),
        owner = coalesce(k.owner, o.owner),
        notes = case when coalesce(o.notes, '') = '' then k.notes when coalesce(k.notes, '') = '' then o.notes else k.notes || E'\\n\\n' || o.notes end,
        fields = o.fields || k.fields,
        tags = (select coalesce(array_agg(t order by first), '{}') from (
                  select (array_agg(t order by n))[1] as t, min(n) as first
                  from unnest(k.tags || o.tags) with ordinality as x(t, n) group by lower(t)) d),
        other_emails = (select coalesce(array_agg(distinct e), '{}') from unnest(k.other_emails || o.other_emails || array[lower(o.email::text)]) e
                        where e is not null and e is distinct from lower(k.email::text)),
        last_contact_at = greatest(k.last_contact_at, o.last_contact_at),
        updated_at = now(), updated_by = ${user}
      from customers o
      where k.id = ${keep}::bigint and o.id = ${other}::bigint and k.id <> o.id and k.merged_into is null and o.merged_into is null
      returning k.id`,
    q`insert into customer_notes (customer_id, kind, body, author)
      select ${keep}::bigint, 'note', 'Merged #' || o.id || ' ' || o.name || coalesce(' (' || nullif(concat_ws(', ', o.email::text, o.phone), '') || ')', '') || ' into this record.', ${user}
      from customers o where o.id = ${other}::bigint and o.merged_into is null
        and exists (select 1 from customers k where k.id = ${keep}::bigint and k.merged_into is null)`,
    q`update customer_notes set customer_id = ${keep}::bigint where customer_id = ${other}::bigint
      and not exists (select 1 from customers x where x.id in (${keep}::bigint, ${other}::bigint) and x.merged_into is not null)`,
    q`update customer_visits set customer_id = ${keep}::bigint where customer_id = ${other}::bigint
      and not exists (select 1 from customers x where x.id in (${keep}::bigint, ${other}::bigint) and x.merged_into is not null)`,
    q`update deals set customer_id = ${keep}::bigint where customer_id = ${other}::bigint
      and not exists (select 1 from customers x where x.id in (${keep}::bigint, ${other}::bigint) and x.merged_into is not null)`,
    q`update follow_ups set customer_id = ${keep}::bigint where customer_id = ${other}::bigint
      and not exists (select 1 from customers x where x.id in (${keep}::bigint, ${other}::bigint) and x.merged_into is not null)`,
    q`update customers set email = null, phone = null, other_emails = '{}', merged_into = ${keep}::bigint,
        archived_at = coalesce(archived_at, now()), updated_at = now(), updated_by = ${user}
      where id = ${other}::bigint and merged_into is null
        and exists (select 1 from customers k where k.id = ${keep}::bigint and k.merged_into is null)
      returning id`,
  ]);
  if (out[out.length - 1].length) return { ok: true, customer: (await getCustomer(db, keep))! };
  const [k, o] = await Promise.all([getCustomer(db, keep), getCustomer(db, other)]);
  return !k || !o ? { ok: false, reason: "missing" } : { ok: false, reason: "merged" };
}

/**
 * Who might be the same person: active records with the same name, or the
 * same phone (its last ten digits), other than this one. At most `limit`.
 */
export async function possibleDuplicates(db: Db, c: Customer, limit = 5): Promise<Customer[]> {
  return db.sql<Customer>`
    select d.*, d.updated_at::text as k from customers d
    where d.id <> ${c.id}::bigint and d.archived_at is null and d.merged_into is null
      and (lower(btrim(d.name)) = lower(btrim(${c.name}))
           or (${c.phone}::text is not null
               and length(regexp_replace(${c.phone}::text, '[^0-9]', '', 'g')) >= 7
               and right(regexp_replace(d.phone, '[^0-9]', '', 'g'), 10) = right(regexp_replace(${c.phone}::text, '[^0-9]', '', 'g'), 10)))
    order by d.updated_at desc, d.id desc
    limit ${limit}`;
}

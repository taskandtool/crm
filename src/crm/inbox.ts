// What came in: form submissions (not spam), bookings and payments, newest
// first across all three, each matched to a customer (by email, then by
// phone where one side has no email: customers.ts findMatch says why) or
// offered as a new one. Tables the project does not have are skipped
// (tables.ts), and crm.config.json's `inbox` says which forms count.
//
// Paging is keyset over the union: every source is read in the same total
// order, (created_at, source rank, id) descending, each returns at most one
// page after the cursor, and the merge keeps the first page of the lot. The
// cursor's time is fixed-width UTC text with microseconds, so it compares as
// text and casts back exactly (admin/keyset.ts has the microsecond rule).
import type { Db } from "../data/db";
import { normalizeEmail } from "../data/email";
import type { CustomField, InboxConfig } from "../config-schema";
import { createCustomer, fillBlanks, validK, type Customer } from "./customers";
import { readFields } from "./fields";
import { cleanPhone } from "./phone";
import { clean } from "./text";
import { present as presentTables, type Present } from "./tables";

export type InboxKind = "submission" | "booking" | "payment";
const RANK: Record<InboxKind, number> = { submission: 0, booking: 1, payment: 2 };

type Base = {
  id: string;
  k: string;
  created_at: Date;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_archived_at: Date | null;
};
export type SubmissionRow = Base & { kind: "submission"; form_key: string; form_title: string | null; data: Record<string, unknown> };
export type BookingRow = Base & { kind: "booking"; starts_at: Date; ends_at: Date; resource_name: string | null; type_name: string | null };
export type PaymentRow = Base & { kind: "payment"; amount_cents: string; currency: string; pay_kind: string; description: string | null; livemode: boolean | null };
export type InboxRow = SubmissionRow | BookingRow | PaymentRow;

export type InboxCursor = { k: string; r: number; id: string };
export type InboxOptions = {
  inbox: InboxConfig;
  /** Only rows that came in at or after this instant. */
  since?: Date | null;
  /** Only rows with no matching customer. */
  unmatched?: boolean;
  /** Only this form's submissions (no bookings or payments). */
  form?: string | null;
};

export function makeInboxCursor(row: InboxRow): string {
  return b64url(JSON.stringify([row.k, RANK[row.kind], row.id]));
}

export function readInboxCursor(s: string | null | undefined): InboxCursor | null {
  if (!s) return null;
  try {
    const [k, r, id] = JSON.parse(fromB64url(s));
    if (typeof k !== "string" || !validK(k) || ![0, 1, 2].includes(r) || typeof id !== "string" || !/^\d{1,18}$/.test(id)) return null;
    return { k, r, id };
  } catch {
    return null;
  }
}

/** Newest first: by time, then source rank, then id, all descending. */
function newer(a: InboxRow, b: InboxRow): number {
  if (a.k !== b.k) return a.k < b.k ? 1 : -1;
  if (RANK[a.kind] !== RANK[b.kind]) return RANK[b.kind] - RANK[a.kind];
  return BigInt(a.id) < BigInt(b.id) ? 1 : -1;
}

export async function inboxPage(
  db: Db,
  opts: InboxOptions,
  after: InboxCursor | null,
  size: number,
): Promise<{ rows: InboxRow[]; next: string | null; present: Present }> {
  const p = await presentTables(db);
  const ib = opts.inbox;
  const since = opts.since ?? null;
  const unmatched = !!opts.unmatched;
  const form = opts.form ?? null;
  const n = size + 1;
  const ak = after?.k ?? null;
  const ar = after?.r ?? null;
  const aid = after?.id ?? null;
  const all = ib.forms === "all";
  const keys = all ? [] : (ib.forms as string[]);
  const exclude = ib.exclude_forms ?? [];

  const jobs: Promise<InboxRow[]>[] = [];
  if (p.submissions) {
    jobs.push(
      db.sql<SubmissionRow>`
        select 'submission' as kind, s.id::text as id, s.created_at, s.form_key, s.name, s.email::text as email, s.phone, s.status, s.data,
               to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as k,
               m.id::text as customer_id, m.name as customer_name, m.archived_at as customer_archived_at
        from submissions s
        left join lateral (
          select c.id, c.name, c.archived_at from customers c
          where (s.email is not null and c.email = s.email)
             or ((c.email is null or s.email is null) and length(regexp_replace(regexp_replace(coalesce(s.phone, ''), '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g')) >= 7
                 and right(regexp_replace(regexp_replace(c.phone, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10) = right(regexp_replace(regexp_replace(s.phone, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10))
          order by (s.email is not null and c.email = s.email) desc, c.archived_at nulls first, c.id
          limit 1) m on true
        where s.status <> 'spam'
          and (${all}::boolean or s.form_key = any(${keys}::text[]))
          and not (s.form_key = any(${exclude}::text[]))
          and (${form}::text is null or s.form_key = ${form}::text)
          and (${since}::timestamptz is null or s.created_at >= ${since}::timestamptz)
          and (not ${unmatched}::boolean or m.id is null)
          and (${ak}::timestamptz is null or (s.created_at, 0, s.id) < (${ak}::timestamptz, ${ar}::int, ${aid}::bigint))
        order by s.created_at desc, s.id desc
        limit ${n}`,
    );
  }
  if (p.bookings && ib.bookings !== false && !form) {
    // bookings references resources and booking_types, so both are there too.
    jobs.push(
      db.sql<BookingRow>`
        select 'booking' as kind, b.id::text as id, b.created_at, b.starts_at, b.ends_at, b.name, b.email::text as email, b.phone, b.status,
               r.name as resource_name, t.name as type_name,
               to_char(b.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as k,
               m.id::text as customer_id, m.name as customer_name, m.archived_at as customer_archived_at
        from bookings b
        left join resources r on r.id = b.resource_id
        left join booking_types t on t.id = b.type_id
        left join lateral (
          select c.id, c.name, c.archived_at from customers c
          where (b.email is not null and c.email = b.email)
             or ((c.email is null or b.email is null) and length(regexp_replace(regexp_replace(coalesce(b.phone, ''), '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g')) >= 7
                 and right(regexp_replace(regexp_replace(c.phone, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10) = right(regexp_replace(regexp_replace(b.phone, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10))
          order by (b.email is not null and c.email = b.email) desc, c.archived_at nulls first, c.id
          limit 1) m on true
        where (${since}::timestamptz is null or b.created_at >= ${since}::timestamptz)
          and (not ${unmatched}::boolean or m.id is null)
          and (${ak}::timestamptz is null or (b.created_at, 1, b.id) < (${ak}::timestamptz, ${ar}::int, ${aid}::bigint))
        order by b.created_at desc, b.id desc
        limit ${n}`,
    );
  }
  if (p.payments && ib.payments !== false && !form) {
    // Money that actually moved: a checkout nobody finished is not news.
    jobs.push(
      db.sql<PaymentRow>`
        select 'payment' as kind, p.id::text as id, p.created_at, p.name, p.email::text as email, null::text as phone, p.status,
               p.amount_cents::text as amount_cents, p.currency, p.kind as pay_kind, p.description, p.livemode,
               to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as k,
               m.id::text as customer_id, m.name as customer_name, m.archived_at as customer_archived_at
        from payments p
        left join lateral (
          select c.id, c.name, c.archived_at from customers c
          where p.email is not null and c.email = p.email
          order by c.archived_at nulls first, c.id
          limit 1) m on true
        where p.status in ('paid', 'refunded', 'partially_refunded')
          and (${since}::timestamptz is null or p.created_at >= ${since}::timestamptz)
          and (not ${unmatched}::boolean or m.id is null)
          and (${ak}::timestamptz is null or (p.created_at, 2, p.id) < (${ak}::timestamptz, ${ar}::int, ${aid}::bigint))
        order by p.created_at desc, p.id desc
        limit ${n}`,
    );
  }

  const merged = (await Promise.all(jobs)).flat().sort(newer).slice(0, n);
  if (p.forms && merged.some((r) => r.kind === "submission")) {
    const titles = new Map((await db.sql<{ key: string; title: string }>`select key, title from forms`).map((f) => [f.key, f.title]));
    for (const r of merged) if (r.kind === "submission") r.form_title = titles.get(r.form_key) ?? null;
  }
  const rows = merged.slice(0, size);
  return { rows, next: merged.length > size ? makeInboxCursor(rows[rows.length - 1]) : null, present: p };
}

/** What a row is, in a few words: the form's title, "Booking", "Payment". */
export function sourceOf(row: { kind: InboxKind; form_key?: string; form_title?: string | null }): string {
  if (row.kind === "submission") return row.form_title || row.form_key || "Form";
  return row.kind === "booking" ? "Booking" : "Payment";
}

/**
 * Make a customer from a row that came in: its name, email and phone, the
 * source it came from, the first open stage, and its time as the last
 * contact. What else the person gave comes too:
 *
 * - a row with no phone (a payment never has one) takes the latest phone
 *   the same email gave on a submission or booking;
 * - a submission's answers keyed `address`, `company` or a custom field's
 *   key (`defs`, crm.config.json's fields) fill those, read exactly as the
 *   customer form reads them (`gave`); any other answer stays on the
 *   submission.
 *
 * When the person is already a customer, that one is returned, with only
 * its empty values filled from the row (customers.ts fillBlanks). Null when
 * the row does not exist (or is spam).
 */
export async function addFromInbox(
  db: Db,
  kind: InboxKind,
  id: string,
  stage: string,
  user: string,
  defs: CustomField[] = [],
): Promise<{ customer: Customer; created: boolean } | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const p = await presentTables(db);
  type Src = { name: string | null; email: string | null; phone: string | null; created_at: Date; source: string; data: Record<string, unknown> | null };
  let row: Src | undefined;
  if (kind === "submission" && p.submissions) {
    [row] = await db.sql<Src>`
      select s.name, s.email::text as email, s.phone, s.created_at, s.form_key as source, s.data
      from submissions s where s.id = ${id}::bigint and s.status <> 'spam'`;
    if (row && p.forms) {
      const [f] = await db.sql<{ title: string }>`select title from forms where key = ${row.source}`;
      if (f?.title) row.source = f.title;
    }
  } else if (kind === "booking" && p.bookings) {
    // What they booked is where they came from; a visit at their place gave their address.
    [row] = await db.sql<Src>`
      select b.name, b.email::text as email, b.phone, b.created_at, coalesce('Booking: ' || t.name, 'Booking') as source,
             case when b.location_kind = 'their_place' then jsonb_build_object('address', b.location) end as data
      from bookings b left join booking_types t on t.id = b.type_id where b.id = ${id}::bigint`;
  } else if (kind === "payment" && p.payments) {
    [row] = await db.sql<Src>`select name, email::text as email, null::text as phone, created_at, 'Payment' as source, null::jsonb as data from payments where id = ${id}::bigint`;
  }
  if (!row) return null;
  const email = normalizeEmail(row.email);
  const phone = cleanPhone(row.phone) ?? (email ? await latestPhone(db, p, email) : null);
  const name = row.name?.trim() || email || phone || "Unknown";
  const extra = gave(defs, row.data);
  // With nothing to match on but the name, the import's rule: a customer of
  // that name with neither, so a second click finds the one the first made.
  const r = await createCustomer(
    db,
    { name: name.slice(0, 200), email, phone, ...extra, stage, source: row.source, last_contact_at: row.created_at },
    user,
    { bareName: true },
  );
  if (r.created) return r;
  return { customer: await fillBlanks(db, r.customer, { phone, ...extra }, user), created: false };
}

/**
 * The latest phone this email gave on a submission (not spam) or a booking:
 * the tables the project has. Payments carry no phone.
 */
async function latestPhone(db: Db, p: Present, email: string): Promise<string | null> {
  type P = { phone: string; at: Date };
  const jobs: Promise<P[]>[] = [];
  if (p.submissions) {
    jobs.push(db.sql<P>`
      select phone, created_at as at from submissions
      where email = ${email}::citext and status <> 'spam' and nullif(trim(phone), '') is not null
      order by created_at desc, id desc limit 1`);
  }
  if (p.bookings) {
    jobs.push(db.sql<P>`
      select phone, created_at as at from bookings
      where email = ${email}::citext and nullif(trim(phone), '') is not null
      order by created_at desc, id desc limit 1`);
  }
  const [latest] = (await Promise.all(jobs)).flat().sort((a, b) => b.at.getTime() - a.at.getTime());
  return latest ? cleanPhone(latest.phone) : null;
}

/**
 * The address, company and custom fields a submission's answers give, read
 * the way the customer form reads them (app.tsx's POST /customers/:id):
 * `clean` to the same lengths, `readFields` strictly, so a value the form
 * would refuse (a select outside its options, a date that is not one, an
 * object where text belongs) is left out. Other answers are ignored.
 */
export function gave(defs: CustomField[], data: Record<string, unknown> | null): { address: string | null; company: string | null; fields: Record<string, unknown> } {
  const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const own = (k: string) => (Object.prototype.hasOwnProperty.call(d, k) ? d[k] : undefined);
  const input: Record<string, unknown> = {};
  for (const f of defs) if (own(f.key) !== undefined) input[f.key] = own(f.key);
  return { address: clean(own("address"), 500), company: clean(own("company"), 200), fields: readFields(defs, input).set };
}

/** Mark a submission done. The CRM writes no other column of another app's table. */
export async function markDone(db: Db, id: string, user: string): Promise<boolean> {
  if (!/^\d{1,18}$/.test(id)) return false;
  const rows = await db.sql`
    update submissions set status = 'done', updated_at = now(), updated_by = ${user}
    where id = ${id}::bigint and status in ('new', 'read')
    returning id`;
  return rows.length > 0;
}

/** A submission's status, or null when there is none by that id: what markDone found instead. */
export async function submissionStatus(db: Db, id: string): Promise<string | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [row] = await db.sql<{ status: string }>`select status from submissions where id = ${id}::bigint`;
  return row?.status ?? null;
}

export function sinceDays(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

const b64url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)));

/** The forms What came in counts (crm.config.json's inbox), for its filter; none before any app made the forms table. */
export async function formChoices(db: Db, ib: InboxConfig): Promise<{ key: string; title: string }[]> {
  const [{ has }] = await db.sql<{ has: boolean }>`select to_regclass('forms') is not null as has`;
  if (!has) return [];
  const all = await db.sql<{ key: string; title: string }>`select key, title from forms order by title, key`;
  const exclude = ib.exclude_forms ?? [];
  return all.filter((f) => (ib.forms === "all" || ib.forms.includes(f.key)) && !exclude.includes(f.key));
}

// The Inbox: form submissions (not spam), bookings and payments, newest
// first across all three, or only what still needs someone (`todo`: a form
// request or an online booking nobody has marked done or made a deal of),
// each matched to its customer (by email, then by phone where one side has
// no email: customers.ts findMatch says why; the forms and booking skills save
// each person as they arrive). Tables the project does not have are skipped
// (tables.ts), and crm.config.json's `inbox` says which forms count.
//
// Paging is keyset over the union: every source is read in the same total
// order, (created_at, source rank, id) descending, each returns at most one
// page after the cursor, and the merge keeps the first page of the lot. The
// cursor's time is fixed-width UTC text with microseconds, so it compares as
// text and casts back exactly (admin/keyset.ts has the microsecond rule).
import type { Db } from "../data/db";
import { fromB64url, toB64url } from "../data/token";
import type { InboxConfig } from "../config-schema";
import { validK } from "./customers";
import { savePerson } from "../customers/customer";
import { BOOKING_PAGE, saveSubmitter } from "../forms/store";
import { present as presentTables, type Present } from "./tables";
import { byEmail, isCustomer, spliced } from "./sql";

// Who each row is: the one rule (sql.ts), by email, else by phone.
const { sql } = spliced({
  sub_is: isCustomer("s"), sub_email: byEmail("s"), booking_is: isCustomer("b"), booking_email: byEmail("b"), pay_email: byEmail("p"), quote_email: byEmail("qt"),
});

/**
 * What can come in: a form submission, a booking, a payment, a booker's own
 * reschedule or cancel (`change`, the booking skill's booking_changes), and a
 * quote the customer accepted by paying it online (`quote`).
 */
export type InboxKind = "submission" | "booking" | "payment" | "change" | "quote";
const RANK: Record<InboxKind, number> = { submission: 0, booking: 1, payment: 2, change: 3, quote: 4 };
/** A quote's `decided_by` when its Pay button was paid: the invoices skill's webhook writes it. */
const PAID_ONLINE = "paid online";

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
export type BookingRow = Base & { kind: "booking"; starts_at: Date; ends_at: Date; resource_name: string | null; type_name: string | null; /** Marked done in the Inbox. */ handled: boolean };
export type PaymentRow = Base & { kind: "payment"; amount_cents: string; currency: string; pay_kind: string; description: string | null; livemode: boolean | null; /** Marked done in the Inbox. */ handled: boolean };
export type ChangeRow = Base & {
  kind: "change";
  /** rescheduled or cancelled, as status is too. */
  change: "rescheduled" | "cancelled";
  booking_id: string;
  was_starts_at: Date;
  /** The new start of a move; null for a cancel. */
  starts_at: Date | null;
  type_name: string | null;
  resource_name: string | null;
  /** Marked done in the Inbox. */ handled: boolean;
};
export type QuoteRow = Base & { kind: "quote"; number: string; total_cents: string; currency: string; /** Marked done in the Inbox. */ handled: boolean };
export type InboxRow = SubmissionRow | BookingRow | PaymentRow | ChangeRow | QuoteRow;

export type InboxCursor = { k: string; r: number; id: string };
export type InboxOptions = {
  inbox: InboxConfig;
  /** Only rows that came in at or after this instant. */
  since?: Date | null;
  /** Only rows with no matching customer. */
  unmatched?: boolean;
  /** Only this form's submissions (no bookings or payments). */
  form?: string | null;
  /**
   * Only what still needs someone: a submission, an online booking still
   * scheduled (one completed, a no-show or cancelled was dealt with), a
   * booker's change or a quote accepted online, none of them marked done.
   * Payments never are.
   */
  todo?: boolean;
};

export function makeInboxCursor(row: InboxRow): string {
  return toB64url(new TextEncoder().encode(JSON.stringify([row.k, RANK[row.kind], row.id])));
}

export function readInboxCursor(s: string | null | undefined): InboxCursor | null {
  if (!s) return null;
  try {
    const [k, r, id] = JSON.parse(new TextDecoder().decode(fromB64url(s)));
    if (typeof k !== "string" || !validK(k) || ![0, 1, 2, 3, 4].includes(r) || typeof id !== "string" || !/^\d{1,18}$/.test(id)) return null;
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
  const todo = !!opts.todo;
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
      sql(db)<SubmissionRow>`
        select 'submission' as kind, s.id::text as id, s.created_at, s.form_key, s.name, s.email::text as email, s.phone, s.status, s.data,
               to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as k,
               m.id::text as customer_id, m.name as customer_name, m.archived_at as customer_archived_at
        from submissions s
        left join lateral (
          select c.id, c.name, c.archived_at from customers c
          where {sub_is}
          order by {sub_email} desc, c.archived_at nulls first, c.id
          limit 1) m on true
        where s.status <> 'spam'
          and s.form_key <> ${BOOKING_PAGE.key}
          and (${all}::boolean or s.form_key = any(${keys}::text[]))
          and not (s.form_key = any(${exclude}::text[]))
          and (${form}::text is null or s.form_key = ${form}::text)
          and (${since}::timestamptz is null or s.created_at >= ${since}::timestamptz)
          and (not ${unmatched}::boolean or m.id is null)
          and (not ${todo}::boolean or s.status in ('new', 'read'))
          and (${ak}::timestamptz is null or (s.created_at, 0, s.id) < (${ak}::timestamptz, ${ar}::int, ${aid}::bigint))
        order by s.created_at desc, s.id desc
        limit ${n}`,
    );
  }
  if (ib.bookings !== false && !form) {
    jobs.push(
      sql(db)<BookingRow>`
        select 'booking' as kind, b.id::text as id, b.created_at, b.starts_at, b.ends_at, b.name, b.email::text as email, b.phone, b.status,
               r.name as resource_name, t.name as type_name,
               exists (select 1 from inbox_done d where d.kind = 'booking' and d.ref_id = b.id) as handled,
               to_char(b.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as k,
               m.id::text as customer_id, m.name as customer_name, m.archived_at as customer_archived_at
        from bookings b
        left join resources r on r.id = b.resource_id
        left join booking_types t on t.id = b.type_id
        left join lateral (
          select c.id, c.name, c.archived_at from customers c
          where {booking_is}
          order by {booking_email} desc, c.archived_at nulls first, c.id
          limit 1) m on true
        where coalesce(b.source, '') <> 'crm' -- one the team put on the schedule is not news
          and b.hold_until is null -- nor one held for a form still being paid
          and (${since}::timestamptz is null or b.created_at >= ${since}::timestamptz)
          and (not ${unmatched}::boolean or m.id is null)
          and (not ${todo}::boolean or (b.status = 'confirmed'
               and not exists (select 1 from inbox_done d where d.kind = 'booking' and d.ref_id = b.id)))
          and (${ak}::timestamptz is null or (b.created_at, 1, b.id) < (${ak}::timestamptz, ${ar}::int, ${aid}::bigint))
        order by b.created_at desc, b.id desc
        limit ${n}`,
    );
  }
  if (p.payments && ib.payments !== false && !form && !todo) {
    // Money that actually moved: a checkout nobody finished is not news. Nor is it
    // something to do (the receipt went from Stripe), so it is in Everything only.
    jobs.push(
      sql(db)<PaymentRow>`
        select 'payment' as kind, p.id::text as id, p.created_at, p.name, p.email::text as email, null::text as phone, p.status,
               p.amount_cents::text as amount_cents, p.currency, p.kind as pay_kind, p.description, p.livemode,
               exists (select 1 from inbox_done d where d.kind = 'payment' and d.ref_id = p.id) as handled,
               to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as k,
               m.id::text as customer_id, m.name as customer_name, m.archived_at as customer_archived_at
        from payments p
        left join lateral (
          select c.id, c.name, c.archived_at from customers c
          where {pay_email}
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

  if (ib.bookings !== false && !form) {
    // What a booker changed themselves through their manage link: the team did not.
    jobs.push(
      sql(db)<ChangeRow>`
        select 'change' as kind, x.id::text as id, x.created_at, b.name, b.email::text as email, b.phone, x.kind as status, x.kind as change,
               b.id::text as booking_id, x.was_starts_at, x.starts_at, t.name as type_name, r.name as resource_name,
               exists (select 1 from inbox_done d where d.kind = 'change' and d.ref_id = x.id) as handled,
               to_char(x.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as k,
               m.id::text as customer_id, m.name as customer_name, m.archived_at as customer_archived_at
        from booking_changes x
        join bookings b on b.id = x.booking_id
        left join resources r on r.id = b.resource_id
        left join booking_types t on t.id = b.type_id
        left join lateral (
          select c.id, c.name, c.archived_at from customers c
          where {booking_is}
          order by {booking_email} desc, c.archived_at nulls first, c.id
          limit 1) m on true
        where (${since}::timestamptz is null or x.created_at >= ${since}::timestamptz)
          and (not ${unmatched}::boolean or m.id is null)
          and (not ${todo}::boolean or not exists (select 1 from inbox_done d where d.kind = 'change' and d.ref_id = x.id))
          and (${ak}::timestamptz is null or (x.created_at, 3, x.id) < (${ak}::timestamptz, ${ar}::int, ${aid}::bigint))
        order by x.created_at desc, x.id desc
        limit ${n}`,
    );
  }
  if (p.quotes && !form) {
    // The customer's own yes: a quote paid through its Pay button. One the team marked is not news.
    jobs.push(
      sql(db)<QuoteRow>`
        select 'quote' as kind, qt.id::text as id, qt.decided_at as created_at, qt.name, qt.email::text as email, qt.phone, qt.status,
               qt.number, qt.total_cents::text as total_cents, qt.currency,
               exists (select 1 from inbox_done d where d.kind = 'quote' and d.ref_id = qt.id) as handled,
               to_char(qt.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as k,
               m.id::text as customer_id, m.name as customer_name, m.archived_at as customer_archived_at
        from quotes qt
        left join lateral (
          select c.id, c.name, c.archived_at from customers c
          where {quote_email}
          order by c.archived_at nulls first, c.id
          limit 1) m on true
        where qt.status = 'accepted' and qt.decided_by = ${PAID_ONLINE} and qt.decided_at is not null
          and (${since}::timestamptz is null or qt.decided_at >= ${since}::timestamptz)
          and (not ${unmatched}::boolean or m.id is null)
          and (not ${todo}::boolean or not exists (select 1 from inbox_done d where d.kind = 'quote' and d.ref_id = qt.id))
          and (${ak}::timestamptz is null or (qt.decided_at, 4, qt.id) < (${ak}::timestamptz, ${ar}::int, ${aid}::bigint))
        order by qt.decided_at desc, qt.id desc
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
export function sourceOf(row: { kind: InboxKind; form_key?: string; form_title?: string | null; number?: string }): string {
  if (row.kind === "submission") return row.form_title || row.form_key || "Form";
  if (row.kind === "quote") return `Quote ${row.number ?? ""}`.trim();
  return row.kind === "payment" ? "Payment" : "Booking";
}

/** What came in, for the New deal form it opens (Pipedrive's Convert to deal): who, the deal's title, and what they said. */
export type Request = { name: string | null; email: string | null; phone: string | null; title: string; said: string | null };

/**
 * An Inbox item as a deal starts from it: the person, the deal named for what
 * they asked (the form, the booked service), and what they wrote. Null when
 * it is not there, or is spam.
 */
export async function requestOf(db: Db, kind: InboxKind, id: string): Promise<Request | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const p = await presentTables(db);
  if (kind === "submission" && p.submissions) {
    const [s] = await db.sql<{ name: string | null; email: string | null; phone: string | null; data: Record<string, unknown> | null; form_key: string }>`
      select s.name, s.email::text as email, s.phone, s.data, s.form_key from submissions s where s.id = ${id}::bigint and s.status <> 'spam'`;
    if (!s) return null;
    const [f] = p.forms ? await db.sql<{ title: string }>`select title from forms where key = ${s.form_key}` : [];
    return { name: s.name, email: s.email, phone: s.phone, title: f?.title ?? s.form_key, said: firstText(s.data) };
  }
  if (kind === "booking") {
    const [b] = await db.sql<{ name: string | null; email: string | null; phone: string | null; title: string }>`
      select b.name, b.email::text as email, b.phone, coalesce(t.name, b.title, 'Booking') as title
      from bookings b left join booking_types t on t.id = b.type_id where b.id = ${id}::bigint`;
    return b ? { ...b, said: null } : null;
  }
  if (kind === "payment" && p.payments) {
    const [r] = await db.sql<{ name: string | null; email: string | null; description: string | null }>`
      select name, email::text as email, description from payments where id = ${id}::bigint`;
    return r ? { name: r.name, email: r.email, phone: null, title: r.description || "Payment", said: null } : null;
  }
  return null;
}

/** The first answer worth reading: a message if there is one, else the first text. */
export function firstText(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  const entries = Object.entries(data).filter(([k, v]) => !k.startsWith("_") && typeof v === "string" && v.trim());
  const msg = entries.find(([k]) => /message|comment|note|details|question|enquiry|inquiry|about|reason|issue|problem|describe/i.test(k)) ?? entries[0];
  return msg ? String(msg[1]).slice(0, 300) : null;
}

/**
 * Everyone already in the project's tables who is not a customer yet, saved
 * through the customers skill's savePerson, the way the forms and booking
 * skills save each person as they arrive: what came in before they did, or
 * through an app on an older copy of them. Every submission (not spam),
 * booking and payment is looked at, none left for later. Run by setup at
 * start and deploy, never per request. Returns how many it saved.
 */
export async function saveEveryone(db: Db): Promise<number> {
  const p = await presentTables(db);
  const count = async () => (await db.sql<{ n: number }>`select count(*)::int as n from customers`)[0].n;
  const before = await count();
  if (p.submissions) {
    const subs = await sql(db)<{ id: string }>`
      select s.id::text as id from submissions s
      where s.status <> 'spam' and s.form_key <> ${BOOKING_PAGE.key} and (s.email is not null or s.phone is not null)
        and not exists (select 1 from customers c where {sub_is})
      order by s.created_at, s.id`;
    for (const s of subs) await saveSubmitter(db, s.id);
  }
  const bookings = await sql(db)<{ name: string | null; email: string | null; phone: string | null; created_at: Date; type_name: string | null; address: string | null }>`
    select b.name, b.email::text as email, b.phone, b.created_at, t.name as type_name,
           case when b.location_kind = 'their_place' then b.location end as address
    from bookings b left join booking_types t on t.id = b.type_id
    where (b.email is not null or b.phone is not null) and not exists (select 1 from customers c where {booking_is})
    order by b.created_at, b.id`;
  for (const b of bookings) {
    await savePerson(db, { name: b.name, email: b.email, phone: b.phone, source: b.type_name ? `Booking: ${b.type_name}` : "Booking", at: b.created_at, answers: b.address ? { address: b.address } : null }, null);
  }
  if (p.payments) {
    const paid = await sql(db)<{ name: string | null; email: string; created_at: Date }>`
      select p.name, p.email::text as email, p.created_at from payments p
      where p.status in ('paid', 'refunded', 'partially_refunded') and p.email is not null
        and not exists (select 1 from customers c where {pay_email})
      order by p.created_at, p.id`;
    for (const r of paid) await savePerson(db, { name: r.name, email: r.email, phone: null, source: "Payment", at: r.created_at }, null);
  }
  return (await count()) - before;
}

/**
 * Undo Done, as Gmail's Undo after an archive: a submission back to read (it
 * was opened), anything else off inbox_done. False when it was not done.
 */
export async function markUndone(db: Db, kind: InboxKind, id: string): Promise<boolean> {
  if (!/^\d{1,18}$/.test(id)) return false;
  const rows = kind === "submission"
    ? await db.sql`update submissions set status = 'read', updated_at = now() where id = ${id}::bigint and status = 'done' returning id`
    : await db.sql`delete from inbox_done where kind = ${kind} and ref_id = ${id}::bigint returning ref_id`;
  return rows.length > 0;
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

/** The Inbox kinds marked done here rather than by a status of their own (a submission's). */
export type HandledKind = "booking" | "payment" | "change" | "quote";
export const HANDLED_KINDS: HandledKind[] = ["booking", "payment", "change", "quote"];

/**
 * Mark a booking, payment, booker's change or online quote acceptance done
 * (inbox_done): off To do, the row itself unchanged (it is another skill's).
 */
export async function markHandled(db: Db, kind: HandledKind, id: string, user: string): Promise<"done" | "already" | "missing"> {
  if (!/^\d{1,18}$/.test(id)) return "missing";
  const p = await presentTables(db);
  if ((kind === "payment" && !p.payments) || (kind === "quote" && !p.quotes)) return "missing";
  const found =
    kind === "booking" ? await db.sql`select 1 from bookings where id = ${id}::bigint`
    : kind === "payment" ? await db.sql`select 1 from payments where id = ${id}::bigint`
    : kind === "change" ? await db.sql`select 1 from booking_changes where id = ${id}::bigint`
    : await db.sql`select 1 from quotes where id = ${id}::bigint and status = 'accepted'`;
  if (!found.length) return "missing";
  const rows = await db.sql`insert into inbox_done (kind, ref_id, done_by) values (${kind}, ${id}::bigint, ${user}) on conflict do nothing returning ref_id`;
  return rows.length ? "done" : "already";
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

/** The forms the Inbox counts (crm.config.json's inbox), for its filter; none before any app made the forms table. */
export async function formChoices(db: Db, ib: InboxConfig): Promise<{ key: string; title: string }[]> {
  const [{ has }] = await db.sql<{ has: boolean }>`select to_regclass('forms') is not null as has`;
  if (!has) return [];
  const all = await db.sql<{ key: string; title: string }>`select key, title from forms order by title, key`;
  const exclude = ib.exclude_forms ?? [];
  return all.filter((f) => (ib.forms === "all" || ib.forms.includes(f.key)) && !exclude.includes(f.key));
}

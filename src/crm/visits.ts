// A customer's jobs, visits, appointments or events (crm.config.json's
// `visits` names them): what it was, when, who did it, whether it happened,
// what it was worth, and the business's own fields (which truck, which
// location). Planned, done or cancelled; never deleted. A visit marked done
// counts as contact, as a call does, and is never in the future: one marked
// done with no time, or a time still to come, happened now.
import type { Cursor, Keyed } from "../admin/keyset";
import type { CsvColumn } from "../admin/csv";
import { likePattern } from "../admin/query";
import type { CustomField } from "../config-schema";
import { q, type Db } from "../data/db";
import { fieldText } from "./fields";

export const VISIT_STATUSES = ["planned", "done", "cancelled"] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];
export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = { planned: "Planned", done: "Done", cancelled: "Cancelled" };
export const pickVisitStatus = (v: unknown): VisitStatus | null => (VISIT_STATUSES.includes(v as VisitStatus) ? (v as VisitStatus) : null);

export type Visit = Keyed & {
  id: string;
  customer_id: string;
  title: string;
  status: VisitStatus;
  starts_at: Date | null;
  owner: string | null;
  amount_cents: string | null;
  currency: string | null;
  fields: Record<string, unknown>;
  notes: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  booking_id: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
};

export type VisitInput = {
  title: string;
  status: VisitStatus;
  /** A wall time ("2026-10-02 14:30:00", text.ts's wallTime) in `timeZone`, or null for not scheduled. */
  at: string | null;
  timeZone: string;
  owner: string | null;
  amount_cents: number | null;
  currency: string;
  notes: string | null;
  fields: Record<string, unknown>;
};

/** The views of the list: what is coming up (planned, soonest first), what was done, everything. */
export type VisitView = "upcoming" | "done" | "all";
export type VisitFilter = { view: VisitView; owner: string | null; q: string | null };

const digitsOf = (currency: string): number => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
};

/**
 * "1,245.50" or "$90" as minor units of `currency`: null for an empty box,
 * "invalid" for anything that is not a plain amount of zero or more (a
 * comma is read as a thousands separator, never as a decimal point).
 */
export function parseAmount(v: unknown, currency: string): number | null | "invalid" {
  const s = typeof v === "string" ? v.trim().replace(/^\p{Sc}\s*/u, "").replace(/[, ]/g, "") : typeof v === "number" ? String(v) : "";
  if (!s) return null;
  const d = digitsOf(currency);
  const m = s.match(d ? new RegExp(`^(\\d{1,12})(?:\\.(\\d{1,${d}}))?$`) : /^(\d{1,12})$/);
  if (!m) return "invalid";
  return Number(m[1]) * 10 ** d + Number((m[2] ?? "").padEnd(d, "0") || 0);
}

/** Minor units as a plain amount for an input or a CSV cell: 124550 USD is "1245.50". */
export function amountText(cents: string | number | null, currency: string): string {
  if (cents === null || cents === "") return "";
  const d = digitsOf(currency);
  const n = BigInt(cents);
  if (!d) return n.toString();
  const unit = 10n ** BigInt(d);
  return `${n / unit}.${(n % unit).toString().padStart(d, "0")}`;
}

// The customer's last contact moves to their latest visit done, as a call's
// does, and never back. By the visit's id, after its write in the same
// transaction, so the two never part.
const touch = (visitId: string, user: string) => q`
  update customers c set
    last_contact_at = greatest(c.last_contact_at,
      (select max(v.starts_at) from customer_visits v where v.customer_id = c.id and v.status = 'done')),
    updated_at = now(), updated_by = ${user}
  where c.id = (select customer_id from customer_visits where id = ${visitId}::bigint)`;

/** Add one to a customer. Null when the customer does not exist. */
export async function addVisit(db: Db, customerId: string, v: VisitInput, user: string): Promise<Visit | null> {
  if (!/^\d{1,18}$/.test(customerId)) return null;
  const [rows] = await db.transaction([
    q`insert into customer_visits (customer_id, title, status, starts_at, owner, amount_cents, currency, fields, notes, created_by, updated_by)
      select ${customerId}::bigint, ${v.title}, ${v.status},
             case when ${v.status} = 'done' then least(coalesce(${v.at}::timestamp at time zone ${v.timeZone}::text, now()), now())
                  else ${v.at}::timestamp at time zone ${v.timeZone}::text end,
             ${v.owner}, ${v.amount_cents}::bigint, ${v.amount_cents === null ? null : v.currency}, ${JSON.stringify(v.fields)}::jsonb, ${v.notes}, ${user}, ${user}
      where exists (select 1 from customers where id = ${customerId}::bigint)
      returning id::text as id`,
    q`update customers set
        last_contact_at = greatest(last_contact_at,
          (select max(starts_at) from customer_visits where customer_id = ${customerId}::bigint and status = 'done')),
        updated_at = now(), updated_by = ${user}
      where id = ${customerId}::bigint`,
  ]);
  const id = (rows[0] as { id: string } | undefined)?.id;
  return id ? getVisit(db, id) : null;
}

/**
 * Save the whole form: every column, and the custom fields `set` merged in
 * and `unset` removed (a field the config no longer declares keeps its
 * value). Null when it does not exist.
 */
export async function saveVisit(db: Db, id: string, v: VisitInput & { unset: string[] }, user: string): Promise<Visit | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [rows] = await db.transaction([
    q`update customer_visits set
        title = ${v.title}, status = ${v.status},
        starts_at = case when ${v.status} = 'done' then least(coalesce(${v.at}::timestamp at time zone ${v.timeZone}::text, now()), now())
                         else ${v.at}::timestamp at time zone ${v.timeZone}::text end,
        owner = ${v.owner}, amount_cents = ${v.amount_cents}::bigint, currency = ${v.amount_cents === null ? null : v.currency},
        fields = (fields || ${JSON.stringify(v.fields)}::jsonb) - ${v.unset}::text[],
        notes = ${v.notes}, updated_by = ${user}, updated_at = now()
      where id = ${id}::bigint
      returning id`,
    touch(id, user),
  ]);
  return rows.length ? getVisit(db, id) : null;
}

/** Planned, done or cancelled. Done with no time, or a time still to come, happened now. */
export async function setVisitStatus(db: Db, id: string, status: VisitStatus, user: string): Promise<Visit | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [rows] = await db.transaction([
    q`update customer_visits set status = ${status},
        starts_at = case when ${status} = 'done' then least(coalesce(starts_at, now()), now()) else starts_at end,
        updated_by = ${user}, updated_at = now()
      where id = ${id}::bigint
      returning id`,
    touch(id, user),
  ]);
  return rows.length ? getVisit(db, id) : null;
}

export async function getVisit(db: Db, id: string): Promise<Visit | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [v] = await db.sql<Visit>`
    select v.*, to_char(coalesce(v.starts_at, v.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as k,
           c.name as customer_name, c.email::text as customer_email, c.phone as customer_phone
    from customer_visits v join customers c on c.id = v.customer_id
    where v.id = ${id}::bigint`;
  return v ?? null;
}

/** One customer's: the planned ones first, soonest first, then the rest newest first. */
export function customerVisits(db: Db, customerId: string, limit = 100): Promise<Visit[]> {
  return db.sql<Visit>`
    select v.*, to_char(coalesce(v.starts_at, v.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as k,
           c.name as customer_name, c.email::text as customer_email, c.phone as customer_phone
    from customer_visits v join customers c on c.id = v.customer_id
    where v.customer_id = ${customerId}::bigint
    order by (v.status = 'planned') desc,
             case when v.status = 'planned' then coalesce(v.starts_at, 'infinity') end asc,
             coalesce(v.starts_at, v.created_at) desc, v.id desc
    limit ${limit}`;
}

/**
 * A page of the list. Coming up is the planned ones, soonest first: one past
 * its time and not marked done sits at the top, and so does one not
 * scheduled yet, by when it was added. Done and all are newest first. Keyset
 * by when it happens, then id.
 */
export function visitsPage(db: Db, f: VisitFilter, after: Cursor | null, size: number): Promise<Visit[]> {
  const k = after?.k ?? null;
  const id = after?.id ?? null;
  const pat = likePattern(f.q);
  if (f.view === "upcoming") {
    return db.sql<Visit>`
      select v.*, to_char(coalesce(v.starts_at, v.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as k,
             c.name as customer_name, c.email::text as customer_email, c.phone as customer_phone
      from customer_visits v join customers c on c.id = v.customer_id
      where v.status = 'planned'
        and (${f.owner}::citext is null or v.owner = ${f.owner}::citext)
        and (${pat}::text is null or v.title ilike ${pat} or c.name ilike ${pat})
        and (${k}::timestamptz is null or (coalesce(v.starts_at, v.created_at), v.id) > (${k}::timestamptz, ${id}::bigint))
      order by coalesce(v.starts_at, v.created_at) asc, v.id asc
      limit ${size + 1}`;
  }
  const status = f.view === "done" ? "done" : null;
  return db.sql<Visit>`
    select v.*, to_char(coalesce(v.starts_at, v.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as k,
           c.name as customer_name, c.email::text as customer_email, c.phone as customer_phone
    from customer_visits v join customers c on c.id = v.customer_id
    where (${status}::text is null or v.status = ${status})
      and (${f.owner}::citext is null or v.owner = ${f.owner}::citext)
      and (${pat}::text is null or v.title ilike ${pat} or c.name ilike ${pat})
      and (${k}::timestamptz is null or (coalesce(v.starts_at, v.created_at), v.id) < (${k}::timestamptz, ${id}::bigint))
    order by coalesce(v.starts_at, v.created_at) desc, v.id desc
    limit ${size + 1}`;
}

/**
 * "Make it a job": a planned visit (done, once the booking is completed) for
 * this customer, carrying the booking's type, time, host and place. A
 * booking makes one visit at most: a second click returns the first.
 */
export async function visitFromBooking(db: Db, bookingId: string, customerId: string, user: string): Promise<Visit | null> {
  if (!/^\d{1,18}$/.test(bookingId) || !/^\d{1,18}$/.test(customerId)) return null;
  const [rows] = await db.transaction([
    q`insert into customer_visits (customer_id, booking_id, title, status, starts_at, owner, notes, created_by, updated_by)
      select ${customerId}::bigint, b.id, coalesce(t.name, 'Booking'),
             case when b.status = 'completed' then 'done' when b.status in ('cancelled', 'no_show') then 'cancelled' else 'planned' end,
             b.starts_at, coalesce(r.email::text, r.name),
             concat_ws(E'\n',
               case b.location_kind when 'their_place' then 'At ' || b.location when 'our_place' then 'At ' || b.location
                                    when 'phone' then 'Call ' || b.location when 'video' then 'Video: ' || b.location end,
               nullif(b.answers ->> 'notes', '')),
             ${user}, ${user}
      from bookings b
      left join booking_types t on t.id = b.type_id
      left join resources r on r.id = b.resource_id
      where b.id = ${bookingId}::bigint and exists (select 1 from customers where id = ${customerId}::bigint)
      on conflict (booking_id) where booking_id is not null do nothing
      returning id::text as id`,
  ]);
  const made = (rows[0] as { id: string } | undefined)?.id;
  if (made) return getVisit(db, made);
  const [v] = await db.sql<{ id: string }>`select id::text as id from customer_visits where booking_id = ${bookingId}::bigint`;
  return v ? getVisit(db, v.id) : null;
}

export type OpenBooking = { id: string; starts_at: Date; name: string; email: string; type_name: string | null; host_name: string | null; customer_id: string | null };

/** Confirmed bookings still to come that no job was made from, soonest first: the "booked, not a job yet" list. */
export function bookingsWithoutJob(db: Db, limit = 20): Promise<OpenBooking[]> {
  return db.sql<OpenBooking>`
    select b.id::text as id, b.starts_at, b.name, b.email::text as email, t.name as type_name, r.name as host_name,
           (select c.id::text from customers c where c.email = b.email order by c.archived_at nulls first, c.id limit 1) as customer_id
    from bookings b
    left join booking_types t on t.id = b.type_id
    left join resources r on r.id = b.resource_id
    where b.status = 'confirmed' and b.ends_at > now()
      and not exists (select 1 from customer_visits v where v.booking_id = b.id)
    order by b.starts_at, b.id
    limit ${limit}`;
}

/** Who has done or is down for any, for the owner filter. */
export async function visitOwners(db: Db): Promise<string[]> {
  return (await db.sql<{ owner: string }>`select distinct owner::text as owner from customer_visits where owner is not null order by 1 limit 200`).map((r) => r.owner);
}

/** The CSV of a list: times in the business's zone (a spreadsheet of jobs is read by the day), amounts as plain numbers. */
export function visitCsvColumns(fields: CustomField[], timeZone: string, ownerLabel: string, currency: string): CsvColumn<Visit>[] {
  const wall = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const local = (d: Date | null) => (d ? wall.format(d).replace(",", "") : "");
  return [
    { label: "ID", value: (r) => r.id },
    { label: "Customer", value: (r) => r.customer_name },
    { label: "Customer email", value: (r) => r.customer_email },
    { label: "Customer phone", value: (r) => r.customer_phone },
    { label: "What", value: (r) => r.title },
    { label: `When (${timeZone})`, value: (r) => local(r.starts_at) },
    { label: "Status", value: (r) => VISIT_STATUS_LABELS[r.status] ?? r.status },
    { label: ownerLabel, value: (r) => r.owner },
    { label: `Amount (${currency})`, value: (r) => (r.amount_cents === null ? "" : amountText(r.amount_cents, r.currency ?? currency)) },
    ...fields.map((fd): CsvColumn<Visit> => ({ label: fd.label, value: (r) => fieldText(r.fields?.[fd.key]) })),
    { label: "Notes", value: (r) => r.notes },
    { label: "Added (UTC)", value: (r) => r.created_at },
  ];
}

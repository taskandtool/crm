// The schedule's events (crm.config.json's `events` names them: an
// appointment, a job, a visit). There is one record for each, whoever made it:
// the booking skill's `bookings` row, booked online or put on the schedule by
// the team. What the CRM adds to it: the customer it is for (an online
// booking, by its email), what it was worth, and the business's own fields.
// Scheduled, then completed, no-show or cancelled; never deleted. A completed
// one counts as contact, as a call does.
import type { Cursor, Keyed } from "../admin/keyset";
import type { CsvColumn } from "../admin/csv";
import { likePattern } from "../admin/query";
import { setStatus, type Booking } from "../booking/book";
import type { CustomField } from "../config-schema";
import type { Db } from "../data/db";
import { EVENT_OF, spliced } from "./sql";
import { fieldText } from "./fields";
import { wallTime } from "../customers/notes";
import { amountText, nowIn } from "./text";

export type EventStatus = Booking["status"];

export type Event = Keyed & {
  id: string;
  /** What it is: its title, else its service's name. */
  what: string;
  title: string | null;
  type_id: string | null;
  type_name: string | null;
  starts_at: Date;
  ends_at: Date;
  resource_id: string | null;
  host_name: string | null;
  status: EventStatus;
  /** Who it is for, as the booking holds them. */
  name: string;
  email: string | null;
  phone: string | null;
  location_kind: Booking["location_kind"];
  location: string | null;
  answers: Record<string, unknown>;
  notes: string | null;
  amount_cents: string | null;
  currency: string | null;
  fields: Record<string, unknown>;
  source: string | null;
  created_at: Date;
  updated_at: Date;
  updated_by: string | null;
  /** The customer: the one it names, else the one its email belongs to. */
  customer_id: string | null;
  customer_name: string | null;
};

export type EventInput = {
  title: string | null;
  type_id: string | null;
  /** A wall time ("2026-10-02 14:30:00", customers/notes.ts's wallTime) in `timeZone`. */
  at: string;
  timeZone: string;
  minutes: number;
  resource_id: string | null;
  location: string | null;
  amount_cents: number | null;
  currency: string;
  notes: string | null;
  fields: Record<string, unknown>;
};

/** The views of the list: what is still to happen (scheduled, soonest first), what is over, everything. */
export type EventView = "upcoming" | "past" | "all";
export type EventFilter = { view: EventView; host: string | null; q: string | null };

/** How long one can be, in minutes. */
export const LENGTHS = [15, 30, 45, 60, 90, 120, 180, 240, 480];

/** How long it runs, in minutes. */
export const minutesOf = (e: Pick<Event, "starts_at" | "ends_at">) => Math.round((new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime()) / 60_000);

/** When it starts, as the wall time in `tz` an EventInput's `at` takes. */
export const startWall = (e: Pick<Event, "starts_at">, tz: string) => wallTime(nowIn(tz, new Date(e.starts_at)))!;

// Every read joins the same way: its service and person, and its customer
// (the one it names, else the one whose email or other address it carries).
// Fixed texts of this file, spliced into each statement; values stay parameters.
const SELECT = `b.id::text as id, coalesce(b.title, t.name, 'Untitled') as what, b.title, b.type_id::text as type_id, t.name as type_name,
  b.starts_at, b.ends_at, b.resource_id::text as resource_id, r.name as host_name, b.status, b.name, b.email::text as email, b.phone,
  b.location_kind, b.location, b.answers, b.notes, b.amount_cents::text as amount_cents, b.currency, b.fields, b.source,
  b.created_at, b.updated_at, b.updated_by::text as updated_by, c.id::text as customer_id, c.name as customer_name,
  to_char(b.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as k`;
const FROM = `from bookings b
  left join booking_types t on t.id = b.type_id
  left join resources r on r.id = b.resource_id
  left join lateral (
    select c.id, c.name from customers c
    where c.id = b.customer_id
       or ${EVENT_OF}
    order by c.id = b.customer_id desc nulls last, c.archived_at nulls first, c.id
    limit 1) c on true`;

const { sql, q: qOf } = spliced({ select: SELECT, from: FROM, event_of: EVENT_OF });

// The customer's last contact moves to their latest completed event, as a
// call's does, and never back.
const touch = (customerId: string, user: string) => qOf`
  update customers c set
    last_contact_at = greatest(c.last_contact_at,
      (select max(b.starts_at) from bookings b
       where b.status = 'completed' and b.starts_at <= now()
         and {event_of})),
    updated_at = now(), updated_by = ${user}
  where c.id = ${customerId}::bigint`;

export async function getEvent(db: Db, id: string): Promise<Event | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [e] = await sql(db)<Event>`select {select} {from} where b.id = ${id}::bigint`;
  return e ?? null;
}

/**
 * Put one on the schedule for a customer: their name, email and phone on it,
 * scheduled. Where it happens is the form's, else the service's own place.
 */
export async function addEvent(db: Db, customer: { id: string; name: string; email: string | null; phone: string | null }, v: EventInput, user: string): Promise<Event | null> {
  const [row] = await db.sql<{ id: string }>`
    insert into bookings (type_id, resource_id, starts_at, ends_at, title, name, email, phone, location_kind, location,
                          customer_id, amount_cents, currency, fields, notes, source, updated_by)
    select t.id, ${v.resource_id}::bigint, s.at, s.at + ${v.minutes}::int * interval '1 minute', ${v.title}, ${customer.name}, ${customer.email}, ${customer.phone},
           coalesce(t.location_kind, 'their_place'), coalesce(${v.location}::text, case when t.location_kind in ('our_place', 'video') then t.location end),
           ${customer.id}::bigint, ${v.amount_cents}::bigint, ${v.amount_cents === null ? null : v.currency}, ${JSON.stringify(v.fields)}::jsonb, ${v.notes}, 'crm', ${user}
    from (select ${v.at}::timestamp at time zone ${v.timeZone}::text as at) s
    left join booking_types t on t.id = ${v.type_id}::bigint
    returning id::text as id`;
  return row ? getEvent(db, row.id) : null;
}

/**
 * Save the whole form: every column, and the custom fields `set` merged in
 * and `unset` removed (a field the config no longer declares keeps its
 * value). A new time, person or place raises SEQUENCE, so the person's
 * calendar copy moves with it. Null when it does not exist.
 */
export async function saveEvent(db: Db, id: string, v: EventInput & { unset: string[] }, user: string): Promise<Event | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [row] = await db.sql<{ id: string }>`
    update bookings b set
      title = ${v.title}, type_id = ${v.type_id}::bigint, resource_id = ${v.resource_id}::bigint,
      starts_at = s.at, ends_at = s.at + ${v.minutes}::int * interval '1 minute', location = ${v.location},
      sequence = b.sequence + case when (b.starts_at, b.ends_at, b.resource_id, b.location)
        is distinct from (s.at, s.at + ${v.minutes}::int * interval '1 minute', ${v.resource_id}::bigint, ${v.location}::text) then 1 else 0 end,
      amount_cents = ${v.amount_cents}::bigint, currency = ${v.amount_cents === null ? null : v.currency},
      fields = (b.fields || ${JSON.stringify(v.fields)}::jsonb) - ${v.unset}::text[],
      notes = ${v.notes}, updated_by = ${user}, updated_at = now()
    from (select ${v.at}::timestamp at time zone ${v.timeZone}::text as at) s
    where b.id = ${id}::bigint
    returning b.id::text as id`;
  return row ? getEvent(db, row.id) : null;
}

/**
 * Completed, no-show or cancelled, as the booking skill allows (completed
 * and no-show once it has started; a cancelled one stays cancelled). A
 * completed one is contact. Null when nothing changed.
 */
export async function setEventStatus(db: Db, id: string, status: Exclude<EventStatus, "confirmed">, user: string): Promise<Event | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const changed = await setStatus(db, id, status, user);
  if (!changed) return null;
  const e = await getEvent(db, id);
  if (e?.customer_id && status === "completed") await db.transaction([touch(e.customer_id, user)]);
  return e;
}

/** After a status changed elsewhere (the Calendar's booking pages): a completed one is contact. */
export async function touchFor(db: Db, id: string, user: string): Promise<void> {
  const e = await getEvent(db, id);
  if (e?.customer_id && e.status === "completed") await db.transaction([touch(e.customer_id, user)]);
}

/** One customer's: the scheduled ones first, soonest first, then the rest newest first. */
export function customerEvents(db: Db, customerId: string, limit = 100): Promise<Event[]> {
  return sql(db)<Event>`
    select {select} {from}
    where c.id = ${customerId}::bigint
    order by (b.status = 'confirmed') desc,
             case when b.status = 'confirmed' then b.starts_at end asc,
             b.starts_at desc, b.id desc
    limit ${limit}`;
}

/**
 * A page of the list. Upcoming is the scheduled ones, soonest first (one past
 * its time and not marked yet sits at the top); Past is the completed,
 * no-show and cancelled ones, and All everything, newest first. Keyset by
 * when it starts, then id.
 */
export function eventsPage(db: Db, f: EventFilter, after: Cursor | null, size: number): Promise<Event[]> {
  const k = after?.k ?? null;
  const id = after?.id ?? null;
  const pat = likePattern(f.q);
  const filters = sql(db)<Event>;
  if (f.view === "upcoming") {
    return filters`
      select {select} {from}
      where b.status = 'confirmed'
        and (${f.host}::bigint is null or b.resource_id = ${f.host}::bigint)
        and (${pat}::text is null or coalesce(b.title, t.name) ilike ${pat} or b.name ilike ${pat} or c.name ilike ${pat})
        and (${k}::timestamptz is null or (b.starts_at, b.id) > (${k}::timestamptz, ${id}::bigint))
      order by b.starts_at asc, b.id asc
      limit ${size + 1}`;
  }
  const past = f.view === "past";
  return filters`
    select {select} {from}
    where (not ${past}::boolean or b.status <> 'confirmed')
      and (${f.host}::bigint is null or b.resource_id = ${f.host}::bigint)
      and (${pat}::text is null or coalesce(b.title, t.name) ilike ${pat} or b.name ilike ${pat} or c.name ilike ${pat})
      and (${k}::timestamptz is null or (b.starts_at, b.id) < (${k}::timestamptz, ${id}::bigint))
    order by b.starts_at desc, b.id desc
    limit ${size + 1}`;
}

/** The CSV of a list: times in the business's zone (a spreadsheet of the schedule is read by the day), amounts as plain numbers. */
export function eventCsvColumns(fields: CustomField[], timeZone: string, ownerLabel: string, currency: string, statusLabel: (s: string) => string): CsvColumn<Event>[] {
  const wall = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const local = (d: Date) => wall.format(d).replace(",", "");
  return [
    { label: "ID", value: (r) => r.id },
    { label: "Customer", value: (r) => r.customer_name ?? r.name },
    { label: "Customer email", value: (r) => r.email },
    { label: "Customer phone", value: (r) => r.phone },
    { label: "What", value: (r) => r.what },
    { label: "Service", value: (r) => r.type_name },
    { label: `When (${timeZone})`, value: (r) => local(r.starts_at) },
    { label: "Status", value: (r) => statusLabel(r.status) },
    { label: ownerLabel, value: (r) => r.host_name },
    { label: "Where", value: (r) => r.location },
    { label: `Amount (${currency})`, value: (r) => (r.amount_cents === null ? "" : amountText(r.amount_cents, r.currency ?? currency)) },
    ...fields.map((fd): CsvColumn<Event> => ({ label: fd.label, value: (r) => fieldText(r.fields?.[fd.key]) })),
    { label: "Notes", value: (r) => r.notes },
    { label: "Added (UTC)", value: (r) => r.created_at },
  ];
}

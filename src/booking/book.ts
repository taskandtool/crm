// Taking, moving and cancelling a booking, safely, on either driver.
//
//   const r = await book(db, { typeId, start, name, email, source: "website" });
//   if (r.ok) redirect(`/book/manage/${r.token}?new=1`);   // the token is shown once, never stored
//   else if (r.reason === "taken") ...                     // someone got there first
//
// A customer books a type (an installation, a video call), and one of its
// hosts takes it: the one they picked, or the free one booked least recently.
//
// Why the transaction looks like this (it is the part that is easy to get wrong):
// - It is ONE non-interactive db.transaction: no JavaScript runs between its
//   statements, so it works on the Neon HTTP driver at the edge as well.
// - The first statements take pg_advisory_xact_lock on each candidate
//   host, in id order (two types sharing a host never deadlock). The lock is
//   its own statement: under READ COMMITTED each statement takes a fresh
//   snapshot, so the insert that runs after the lock is granted sees a
//   booking the lock holder just committed. Checking in the same statement
//   that waits for the lock would check against the stale snapshot.
// - The insert is `insert … select … where not exists (overlap)`, and an
//   empty `returning` means the slot was taken. No exclusion constraint, so
//   no btree_gist extension is needed.
// - Before that, the slot is recomputed with slots.ts from fresh rows, so
//   hours, minimum notice and horizon hold for a hand-made POST too.
import { q, type Db, type Query } from "../data/db";
import { normalizeEmail } from "../data/email";
import { newToken, tokenHash, TOKEN_SHAPE } from "../data/token";
import { isValidZone, slots as openSlots, type Interval, type Settings, type Slot, type Window } from "./slots";

/** A person who can be booked: their own zone, hours, time off and calendars. */
export type Resource = {
  id: string;
  name: string;
  email: string | null;
  time_zone: string;
  active: boolean;
};

export const LOCATION_KINDS = ["their_place", "our_place", "phone", "video"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/** What is booked: its rules, where it happens, and (in booking_type_hosts) who can take it. */
export type BookingType = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  duration_min: number;
  interval_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
  min_notice_min: number;
  horizon_days: number;
  location_kind: LocationKind;
  /** The business's address (our_place) or the meeting link (video). */
  location: string | null;
  position: number;
  active: boolean;
  /** What a payment step charges for it, in minor units of `currency`; null is free. */
  price_cents: number | null;
  currency: string | null;
};

export type Booking = {
  id: string;
  type_id: string;
  resource_id: string;
  starts_at: Date;
  ends_at: Date;
  name: string;
  email: string;
  phone: string | null;
  location_kind: LocationKind;
  location: string | null;
  booker_time_zone: string | null;
  status: "confirmed" | "cancelled" | "completed" | "no_show";
  answers: Record<string, unknown>;
  sequence: number;
  source: string | null;
  external_event_id: string | null;
  cancelled_at: Date | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
};

/** One line for where it happens, for the booker. A meeting link is shown only to the person who booked. */
export function whereText(b: Pick<Booking, "location_kind" | "location">, opts: { link?: boolean } = {}): string {
  switch (b.location_kind) {
    case "their_place":
      return b.location ? `At ${b.location}` : "At your address";
    case "our_place":
      return b.location ? `At ${b.location}` : "At our place";
    case "phone":
      return b.location ? `We will call you on ${b.location}` : "By phone";
    case "video":
      return opts.link && b.location ? `Video call: ${b.location}` : "Video call";
  }
}

/** An open slot and the hosts who are free to take it. */
export type OpenSlot = Slot & { members: string[] };

export const settingsOf = (r: BookingType): Settings => ({
  durationMin: r.duration_min,
  intervalMin: r.interval_min,
  bufferBeforeMin: r.buffer_before_min,
  bufferAfterMin: r.buffer_after_min,
  minNoticeMin: r.min_notice_min,
  horizonDays: r.horizon_days,
});

const asDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));

/** A resources row as read by `select *` (bigint ids arrive as text from both drivers). */
export function toResource(r: Record<string, any>): Resource {
  return { id: String(r.id), name: r.name, email: r.email ?? null, time_zone: r.time_zone, active: !!r.active };
}

/** A booking_types row as read by `select *`. */
export function toType(r: Record<string, any>): BookingType {
  return {
    id: String(r.id), slug: r.slug, name: r.name, description: r.description ?? null,
    duration_min: Number(r.duration_min), interval_min: Number(r.interval_min), buffer_before_min: Number(r.buffer_before_min),
    buffer_after_min: Number(r.buffer_after_min), min_notice_min: Number(r.min_notice_min), horizon_days: Number(r.horizon_days),
    location_kind: r.location_kind, location: r.location ?? null, position: Number(r.position), active: !!r.active,
    price_cents: r.price_cents == null ? null : Number(r.price_cents), currency: r.currency ?? null,
  };
}

/** A bookings row as read by `select *`, without the token hash. */
export function toBooking(r: Record<string, any>): Booking {
  return {
    id: String(r.id), type_id: String(r.type_id), resource_id: String(r.resource_id), starts_at: asDate(r.starts_at), ends_at: asDate(r.ends_at),
    name: r.name, email: r.email, phone: r.phone ?? null, location_kind: r.location_kind, location: r.location ?? null,
    booker_time_zone: r.booker_time_zone ?? null, status: r.status,
    answers: (typeof r.answers === "string" ? JSON.parse(r.answers) : r.answers) ?? {}, sequence: Number(r.sequence), source: r.source ?? null,
    external_event_id: r.external_event_id ?? null, cancelled_at: r.cancelled_at ? asDate(r.cancelled_at) : null,
    updated_by: r.updated_by ?? null, created_at: asDate(r.created_at), updated_at: asDate(r.updated_at),
  };
}

export async function resourceById(db: Db, id: string): Promise<Resource | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [r] = await db.sql`select * from resources where id = ${id}::bigint`;
  return r ? toResource(r) : null;
}

export async function typeById(db: Db, id: string): Promise<BookingType | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [r] = await db.sql`select * from booking_types where id = ${id}::bigint`;
  return r ? toType(r) : null;
}

/** The public page's type: active, by its slug. */
export async function typeBySlug(db: Db, slug: string): Promise<BookingType | null> {
  const [r] = await db.sql`select * from booking_types where slug = ${slug} and active`;
  return r ? toType(r) : null;
}

/** Every active type with at least one active host, in the owner's order: the public list. */
export async function bookableTypes(db: Db): Promise<BookingType[]> {
  const rows = await db.sql`
    select t.* from booking_types t
    where t.active and exists (
      select 1 from booking_type_hosts h join resources r on r.id = h.resource_id where h.type_id = t.id and r.active)
    order by t.position, t.name, t.id`;
  return rows.map(toType);
}

/** A type's hosts, by name; only those taking bookings unless `all`. */
export async function hostsOf(db: Db, typeId: string, opts: { all?: boolean } = {}): Promise<Resource[]> {
  const rows = await db.sql`
    select r.* from booking_type_hosts h join resources r on r.id = h.resource_id
    where h.type_id = ${typeId}::bigint and (${!!opts.all}::boolean or r.active)
    order by r.name, r.id`;
  return rows.map(toResource);
}

/**
 * Open slots of a type in [from, to): a start is open when at least one of
 * its active hosts is free, each checked in their own zone and hours with
 * the type's rules. `hosts` narrows it to the ones named (the host a booker
 * picked, or the one a booking being moved stays with).
 */
export async function openSlotsFor(
  db: Db,
  type: BookingType,
  from: Date,
  to: Date,
  now = new Date(),
  opts: { hosts?: string[]; exceptBooking?: string } = {},
): Promise<OpenSlot[]> {
  const st = settingsOf(type);
  if (!type.active) return [];
  const members: { id: string; time_zone: string }[] = await db.sql`
    select r.id::text as id, r.time_zone from booking_type_hosts h join resources r on r.id = h.resource_id
    where h.type_id = ${type.id}::bigint and r.active
      and (${opts.hosts ?? null}::bigint[] is null or r.id = any(${opts.hosts ?? null}::bigint[]))`;
  if (!members.length) return [];
  const ids = members.map((m) => m.id);
  const pad = (st.durationMin + st.bufferBeforeMin + st.bufferAfterMin) * 60_000;
  const lo = new Date(from.getTime() - pad).toISOString();
  const hi = new Date(to.getTime() + pad).toISOString();
  const except = opts.exceptBooking ?? null;

  const [windows, timeOff, busy, bookings] = await Promise.all([
    db.sql`select resource_id::text as rid, weekday, start_local::text as start, end_local::text as "end"
           from availability where resource_id = any(${ids}::bigint[])`,
    db.sql`select resource_id::text as rid, starts_at, ends_at from time_off
           where resource_id = any(${ids}::bigint[]) and starts_at < ${hi}::timestamptz and ends_at > ${lo}::timestamptz`,
    db.sql`select k.resource_id::text as rid, x.starts_at, x.ends_at from busy x
           join calendars k on k.id = x.calendar_id
           where k.resource_id = any(${ids}::bigint[]) and x.starts_at < ${hi}::timestamptz and x.ends_at > ${lo}::timestamptz`,
    db.sql`select resource_id::text as rid, starts_at, ends_at from bookings
           where resource_id = any(${ids}::bigint[]) and status = 'confirmed'
             and starts_at < ${hi}::timestamptz and ends_at > ${lo}::timestamptz
             and (${except}::bigint is null or id <> ${except}::bigint)`,
  ]);
  const of = (rows: Record<string, any>[], rid: string): Interval[] =>
    rows.filter((r) => r.rid === rid).map((r) => ({ start: asDate(r.starts_at), end: asDate(r.ends_at) }));

  const out = new Map<number, OpenSlot>();
  for (const m of members) {
    if (!isValidZone(m.time_zone)) continue;
    const mine: Window[] = windows.filter((w) => w.rid === m.id).map((w) => ({ weekday: w.weekday, start: w.start, end: w.end }));
    for (const s of openSlots({
      zone: m.time_zone, windows: mine, timeOff: of(timeOff, m.id), busy: of(busy, m.id), bookings: of(bookings, m.id),
      settings: st, now, from, to,
    })) {
      const t = s.start.getTime();
      const seen = out.get(t);
      if (seen) seen.members.push(m.id);
      else out.set(t, { ...s, members: [m.id] });
    }
  }
  return [...out.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** The open slot starting exactly at `start`, or null. */
export async function openSlotAt(db: Db, type: BookingType, start: Date, now = new Date(), opts: { hosts?: string[]; exceptBooking?: string } = {}) {
  const t = start.getTime();
  if (!Number.isFinite(t)) return null;
  const list = await openSlotsFor(db, type, new Date(t), new Date(t + 1), now, opts);
  return list.find((s) => s.start.getTime() === t) ?? null;
}

// ---- the manage token ------------------------------------------------------

/** 32 random bytes, base64url: the manage link. Shown once; only its hash is stored. */
export { newToken, tokenHash } from "../data/token";

// ---- the statements ----------------------------------------------------------

/** One lock per host, in id order, each its own statement (see the top of this file). */
function locks(ids: string[]): Query[] {
  return [...new Set(ids)]
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))
    .map((id) => q`select pg_advisory_xact_lock(hashtext('booking:' || ${id}::text))`);
}

// The overlap rules, in SQL, exactly as slots.ts applies them: a confirmed
// booking within before + after of the slot, or busy time / time off within
// the slot padded by its buffers. `r` is the candidate host.

export type BookInput = {
  typeId: string;
  /** The host the booker picked; any free one when absent. */
  hostId?: string | null;
  start: Date;
  name: string;
  email: string;
  /** Required for a phone call: the number the business rings. */
  phone?: string | null;
  /** Required at their place: where the work or the visit is. */
  address?: string | null;
  bookerTimeZone?: string | null;
  answers?: Record<string, unknown>;
  /** The app's slug, e.g. "website". */
  source: string;
  now?: Date;
  /** The form submission it is for (the forms skill's booking step). */
  submissionId?: string | null;
  /** Held for a payment until then (releaseLapsedHolds). */
  holdUntil?: Date | null;
};

export type BookResult =
  | { ok: true; booking: Booking; token: string }
  | { ok: false; reason: "invalid"; errors: Record<string, string> }
  | { ok: false; reason: "not_found" | "taken" };

/** The booker's details, checked for where the type happens. */
export function checkBooker(
  input: { name?: unknown; email?: unknown; phone?: unknown; address?: unknown },
  kind: LocationKind = "our_place",
): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) errors.name = "Enter your name.";
  else if (name.length > 200) errors.name = "Use 200 characters or fewer.";
  if (!normalizeEmail(input.email)) errors.email = "Enter an email address like name@example.com.";
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  if (phone.length > 40) errors.phone = "Use 40 characters or fewer.";
  else if (kind === "phone" && !/\d{3}/.test(phone)) errors.phone = "Enter the number we should call.";
  const address = typeof input.address === "string" ? input.address.trim() : "";
  if (address.length > 500) errors.address = "Use 500 characters or fewer.";
  else if (kind === "their_place" && !address) errors.address = "Enter the address where we should come.";
  return errors;
}

/** Where a booking happens, as it is stored on it. */
export function bookingLocation(type: BookingType, input: { phone?: string | null; address?: string | null }): string | null {
  switch (type.location_kind) {
    case "their_place":
      return input.address?.trim() || null;
    case "phone":
      return input.phone?.trim() || null;
    default:
      return type.location;
  }
}

export async function book(db: Db, input: BookInput): Promise<BookResult> {
  await releaseLapsedHolds(db, input.now);
  const type = await typeById(db, input.typeId);
  if (!type || !type.active) return { ok: false, reason: "not_found" };
  const errors = checkBooker(input, type.location_kind);
  if (Object.keys(errors).length) return { ok: false, reason: "invalid", errors };
  const now = input.now ?? new Date();
  const slot = await openSlotAt(db, type, input.start, now, input.hostId ? { hosts: [input.hostId] } : {});
  if (!slot) return { ok: false, reason: "taken" };
  return takeSlot(db, type, slot, input);
}

/**
 * The transaction alone: lock, re-check in SQL, insert. `book` calls it
 * after the slots.ts check; it is exported so tests can show the SQL holds
 * on its own.
 */
export async function takeSlot(db: Db, type: BookingType, slot: OpenSlot, input: BookInput): Promise<BookResult> {
  const token = newToken();
  const hash = await tokenHash(token);
  const st = settingsOf(type);
  const start = slot.start.toISOString(), end = slot.end.toISOString();
  const gap = st.bufferBeforeMin + st.bufferAfterMin;
  const zone = isValidZone(input.bookerTimeZone) ? input.bookerTimeZone : null;
  const where = bookingLocation(type, input);

  // Among the hosts still free once the locks are held, the one whose latest
  // booking was made longest ago (never booked first), then by id.
  const insert = q`
    insert into bookings
      (type_id, resource_id, starts_at, ends_at, name, email, phone, location_kind, location, booker_time_zone, status, answers, manage_token_hash, source,
       submission_id, hold_until)
    select ${type.id}::bigint, c.id, ${start}::timestamptz, ${end}::timestamptz, ${input.name.trim()}, ${normalizeEmail(input.email)},
           ${input.phone?.trim() || null}, ${type.location_kind}, ${where}, ${zone}, 'confirmed', ${JSON.stringify(input.answers ?? {})}::jsonb,
           ${hash}, ${input.source}, ${input.submissionId ?? null}::bigint, ${input.holdUntil ? input.holdUntil.toISOString() : null}::timestamptz
    from (
      select r.id from resources r
      where r.id = any(${slot.members}::bigint[]) and r.active
        and (${input.submissionId ?? null}::bigint is null or not exists (
          select 1 from bookings o where o.submission_id = ${input.submissionId ?? null}::bigint and o.status = 'confirmed'))
        and exists (select 1 from booking_type_hosts h where h.type_id = ${type.id}::bigint and h.resource_id = r.id)
        and not exists (
          select 1 from bookings b
          where b.resource_id = r.id and b.status = 'confirmed'
            and b.starts_at < ${end}::timestamptz + ${gap}::int * interval '1 minute'
            and b.ends_at > ${start}::timestamptz - ${gap}::int * interval '1 minute')
        and not exists (
          select 1 from busy x join calendars k on k.id = x.calendar_id
          where k.resource_id = r.id
            and x.starts_at < ${end}::timestamptz + ${st.bufferAfterMin}::int * interval '1 minute'
            and x.ends_at > ${start}::timestamptz - ${st.bufferBeforeMin}::int * interval '1 minute')
        and not exists (
          select 1 from time_off t
          where t.resource_id = r.id
            and t.starts_at < ${end}::timestamptz + ${st.bufferAfterMin}::int * interval '1 minute'
            and t.ends_at > ${start}::timestamptz - ${st.bufferBeforeMin}::int * interval '1 minute')
      order by (select max(b.created_at) from bookings b where b.resource_id = r.id and b.status <> 'cancelled') asc nulls first, r.id
      limit 1
    ) c
    returning *`;

  // A form's submission books once: its lock first, so a double submit waits and then finds the first booking.
  const forSubmission = input.submissionId ? [q`select pg_advisory_xact_lock(hashtext(${"booking.submission." + input.submissionId}::text))`] : [];
  const results = await db.transaction([...forSubmission, ...locks(slot.members), insert]);
  const row = results[results.length - 1][0];
  if (!row) return { ok: false, reason: "taken" };
  return { ok: true, booking: toBooking(row), token };
}

/**
 * Cancel the bookings held for a form that was not finished: past
 * hold_until (confirmFormBooking clears it once the form is complete), and no
 * payment for them (or their submission) other than one Stripe gave up on
 * (cancelled, from checkout.session.expired). A payment pending, failed on one card but still
 * open, or paid keeps the time. Their times are free again. Run before slots are listed or taken, and by the reminders job; it
 * reads the payments skill's table only when the project has it.
 */
export async function releaseLapsedHolds(db: Db, now = new Date()): Promise<number> {
  const at = now.toISOString();
  // A table that is not there cannot be named even in a branch that never runs.
  const [{ paying }] = await db.sql<{ paying: boolean }>`select to_regclass('payments') is not null as paying`;
  const rows = paying
    ? await db.sql`
        update bookings b set status = 'cancelled', cancelled_at = ${at}::timestamptz, sequence = sequence + 1, updated_at = now(),
               updated_by = 'form not finished in time'
        where b.status = 'confirmed' and b.hold_until is not null and b.hold_until < ${at}::timestamptz
          and not exists (
            select 1 from payments p
            where ((p.ref_type = 'booking' and p.ref_id = b.id::text) or (p.ref_type = 'submission' and p.ref_id = b.submission_id::text))
              and p.status <> 'cancelled')
        returning b.id`
    : await db.sql`
        update bookings b set status = 'cancelled', cancelled_at = ${at}::timestamptz, sequence = sequence + 1, updated_at = now(),
               updated_by = 'form not finished in time'
        where b.status = 'confirmed' and b.hold_until is not null and b.hold_until < ${at}::timestamptz
        returning b.id`;
  return rows.length;
}

/** The confirmed booking a form's submission made, or null. */
export async function bookingForSubmission(db: Db, submissionId: string): Promise<Booking | null> {
  const [r] = await db.sql`select * from bookings where submission_id = ${submissionId}::bigint and status = 'confirmed' order by id limit 1`;
  return r ? toBooking(r) : null;
}

// ---- the manage link: look up, reschedule, cancel -----------------------------

/** The booking a manage link names, or null (a malformed or unknown token is the same null). */
export async function bookingByToken(db: Db, token: string): Promise<Booking | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const [r] = await db.sql`select * from bookings where manage_token_hash = ${await tokenHash(token)}`;
  return r ? toBooking(r) : null;
}


export type ChangeResult = { ok: true; booking: Booking } | { ok: false; reason: "not_found" | "closed" | "taken" };

/**
 * Move a confirmed, future booking to another open start of its type, with
 * the same host. SEQUENCE rises, so the calendar event and any invite are
 * updated rather than duplicated.
 */
export async function reschedule(db: Db, token: string, newStart: Date, now = new Date()): Promise<ChangeResult> {
  const b = await bookingByToken(db, token);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status !== "confirmed" || b.starts_at <= now) return { ok: false, reason: "closed" };
  const type = await typeById(db, b.type_id);
  if (!type) return { ok: false, reason: "not_found" };
  const slot = await openSlotAt(db, type, newStart, now, { hosts: [b.resource_id], exceptBooking: b.id });
  if (!slot) return { ok: false, reason: "taken" };

  const st = settingsOf(type);
  const start = slot.start.toISOString(), end = slot.end.toISOString();
  const gap = st.bufferBeforeMin + st.bufferAfterMin;
  const move = q`
    update bookings b
    set starts_at = ${start}::timestamptz, ends_at = ${end}::timestamptz, sequence = b.sequence + 1, updated_at = now()
    where b.id = ${b.id}::bigint and b.status = 'confirmed' and b.starts_at > ${now.toISOString()}::timestamptz
      and not exists (
        select 1 from bookings o
        where o.resource_id = b.resource_id and o.id <> b.id and o.status = 'confirmed'
          and o.starts_at < ${end}::timestamptz + ${gap}::int * interval '1 minute'
          and o.ends_at > ${start}::timestamptz - ${gap}::int * interval '1 minute')
      and not exists (
        select 1 from busy x join calendars k on k.id = x.calendar_id
        where k.resource_id = b.resource_id
          and x.starts_at < ${end}::timestamptz + ${st.bufferAfterMin}::int * interval '1 minute'
          and x.ends_at > ${start}::timestamptz - ${st.bufferBeforeMin}::int * interval '1 minute')
      and not exists (
        select 1 from time_off t
        where t.resource_id = b.resource_id
          and t.starts_at < ${end}::timestamptz + ${st.bufferAfterMin}::int * interval '1 minute'
          and t.ends_at > ${start}::timestamptz - ${st.bufferBeforeMin}::int * interval '1 minute')
    returning *`;
  const results = await db.transaction([...locks([b.resource_id]), move]);
  const row = results[results.length - 1][0];
  return row ? { ok: true, booking: toBooking(row) } : { ok: false, reason: "taken" };
}

/** Cancel a confirmed, future booking by its manage link. Its slot is open again at once. */
export async function cancelByToken(db: Db, token: string, now = new Date()): Promise<ChangeResult> {
  if (!TOKEN_SHAPE.test(token)) return { ok: false, reason: "not_found" };
  const [r] = await db.sql`
    update bookings
    set status = 'cancelled', cancelled_at = now(), sequence = sequence + 1, updated_at = now()
    where manage_token_hash = ${await tokenHash(token)} and status = 'confirmed' and starts_at > ${now.toISOString()}::timestamptz
    returning *`;
  if (r) return { ok: true, booking: toBooking(r) };
  return (await bookingByToken(db, token)) ? { ok: false, reason: "closed" } : { ok: false, reason: "not_found" };
}

// ---- the team's changes ------------------------------------------------------------

export const STATUSES = ["confirmed", "completed", "no_show", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];

/**
 * A team member marks a booking completed, no-show or cancelled. A cancelled
 * booking stays cancelled (confirming it again could double-book: book anew).
 * Completed and no-show only once it has started: only confirmed bookings
 * block a slot, so marking a future one would open its time to a second
 * booker. Cancelling raises SEQUENCE so the sync job removes the calendar event.
 */
export async function setStatus(db: Db, id: string, status: Exclude<Status, "confirmed">, by: string): Promise<Booking | null> {
  const [r] = await db.sql`
    update bookings
    set status = ${status}, updated_by = ${by}, updated_at = now(),
        cancelled_at = case when ${status} = 'cancelled' then now() else cancelled_at end,
        sequence = sequence + case when ${status} = 'cancelled' then 1 else 0 end
    where id = ${id}::bigint and status <> 'cancelled' and status <> ${status}
      and (${status} = 'cancelled' or starts_at <= now())
    returning *`;
  return r ? toBooking(r) : null;
}

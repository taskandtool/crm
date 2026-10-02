// Taking, moving and cancelling a booking, safely, on either driver.
//
//   const r = await book(db, { resourceId, start, name, email, source: "website" });
//   if (r.ok) redirect(`/book/manage/${r.token}?new=1`);   // the token is shown once, never stored
//   else if (r.reason === "taken") ...                     // someone got there first
//
// Why the transaction looks like this (it is the part that is easy to get wrong):
// - It is ONE non-interactive db.transaction: no JavaScript runs between its
//   statements, so it works on the Neon HTTP driver at the edge as well.
// - The first statements take pg_advisory_xact_lock on each candidate
//   resource, in id order (two crews sharing a member never deadlock). The
//   lock is its own statement: under READ COMMITTED each statement takes a
//   fresh snapshot, so the insert that runs after the lock is granted sees a
//   booking the lock holder just committed. Checking in the same statement
//   that waits for the lock would check against the stale snapshot.
// - The insert is `insert … select … where not exists (overlap)`, and an
//   empty `returning` means the slot was taken. No exclusion constraint, so
//   no btree_gist extension is needed.
// - Before that, the slot is recomputed with slots.ts from fresh rows, so
//   hours, minimum notice and horizon hold for a hand-made POST too.
import { q, type Db, type Query } from "../data/db";
import { normalizeEmail } from "../data/email";
import { isValidZone, slots as openSlots, type Interval, type Settings, type Slot, type Window } from "./slots";

export type Resource = {
  id: string;
  kind: "person" | "crew";
  slug: string | null;
  name: string;
  email: string | null;
  time_zone: string;
  duration_min: number;
  interval_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
  min_notice_min: number;
  horizon_days: number;
  active: boolean;
};

export type Booking = {
  id: string;
  resource_id: string;
  crew_id: string | null;
  starts_at: Date;
  ends_at: Date;
  name: string;
  email: string;
  phone: string | null;
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

/** An open slot and the resources (one, or a crew's free members) that could take it. */
export type OpenSlot = Slot & { members: string[] };

export const settingsOf = (r: Resource): Settings => ({
  durationMin: r.duration_min,
  intervalMin: r.interval_min,
  bufferBeforeMin: r.buffer_before_min,
  bufferAfterMin: r.buffer_after_min,
  minNoticeMin: r.min_notice_min,
  horizonDays: r.horizon_days,
});

const asDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));
const idOrNull = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** A resources row as read by `select *` (bigint ids arrive as text from both drivers). */
export function toResource(r: Record<string, any>): Resource {
  return {
    id: String(r.id), kind: r.kind, slug: r.slug ?? null, name: r.name, email: r.email ?? null, time_zone: r.time_zone,
    duration_min: Number(r.duration_min), interval_min: Number(r.interval_min), buffer_before_min: Number(r.buffer_before_min),
    buffer_after_min: Number(r.buffer_after_min), min_notice_min: Number(r.min_notice_min), horizon_days: Number(r.horizon_days),
    active: !!r.active,
  };
}

/** A bookings row as read by `select *`, without the token hash. */
export function toBooking(r: Record<string, any>): Booking {
  return {
    id: String(r.id), resource_id: String(r.resource_id), crew_id: idOrNull(r.crew_id), starts_at: asDate(r.starts_at), ends_at: asDate(r.ends_at),
    name: r.name, email: r.email, phone: r.phone ?? null, booker_time_zone: r.booker_time_zone ?? null, status: r.status,
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

/** The public page's resource: active, by its slug. */
export async function resourceBySlug(db: Db, slug: string): Promise<Resource | null> {
  const [r] = await db.sql`select * from resources where slug = ${slug} and active`;
  return r ? toResource(r) : null;
}

/**
 * Open slots of a resource in [from, to). A person is checked against their
 * own hours; a crew's slot is open when at least one active member is free,
 * each member checked in their own zone and hours with the crew's settings.
 */
export async function openSlotsFor(
  db: Db,
  resource: Resource,
  from: Date,
  to: Date,
  now = new Date(),
  opts: { members?: string[]; exceptBooking?: string } = {},
): Promise<OpenSlot[]> {
  const st = settingsOf(resource);
  let members: { id: string; time_zone: string }[];
  if (opts.members) {
    members = await db.sql`select id::text as id, time_zone from resources where id = any(${opts.members}::bigint[]) and active`;
  } else if (resource.kind === "crew") {
    members = await db.sql`
      select r.id::text as id, r.time_zone from resource_members m
      join resources r on r.id = m.member_id
      where m.crew_id = ${resource.id}::bigint and r.active and r.kind = 'person'`;
  } else {
    members = resource.active ? [{ id: resource.id, time_zone: resource.time_zone }] : [];
  }
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
export async function openSlotAt(db: Db, resource: Resource, start: Date, now = new Date(), opts: { members?: string[]; exceptBooking?: string } = {}) {
  const t = start.getTime();
  if (!Number.isFinite(t)) return null;
  const list = await openSlotsFor(db, resource, new Date(t), new Date(t + 1), now, opts);
  return list.find((s) => s.start.getTime() === t) ?? null;
}

// ---- the manage token ------------------------------------------------------

/** 32 random bytes, base64url: the manage link. Shown once; only its hash is stored. */
export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Hex SHA-256 of a token. Looking a booking up by this hash is the
 * constant-time comparison: an attacker can time the index lookup only on a
 * hash, which tells them nothing about any real token.
 */
export async function tokenHash(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

// ---- the statements ----------------------------------------------------------

/** One lock per resource, in id order, each its own statement (see the top of this file). */
function locks(ids: string[]): Query[] {
  return [...new Set(ids)]
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))
    .map((id) => q`select pg_advisory_xact_lock(hashtext('booking:' || ${id}::text))`);
}

// The overlap rules, in SQL, exactly as slots.ts applies them: a confirmed
// booking within before + after of the slot, or busy time / time off within
// the slot padded by its buffers. `r` is the candidate resource.

export type BookInput = {
  resourceId: string;
  start: Date;
  name: string;
  email: string;
  phone?: string | null;
  bookerTimeZone?: string | null;
  answers?: Record<string, unknown>;
  /** The app's slug, e.g. "website". */
  source: string;
  now?: Date;
};

export type BookResult =
  | { ok: true; booking: Booking; token: string }
  | { ok: false; reason: "invalid"; errors: Record<string, string> }
  | { ok: false; reason: "not_found" | "taken" };

export function checkBooker(input: { name?: unknown; email?: unknown; phone?: unknown; bookerTimeZone?: unknown }): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) errors.name = "Enter your name.";
  else if (name.length > 200) errors.name = "Use 200 characters or fewer.";
  if (!normalizeEmail(input.email)) errors.email = "Enter an email address like name@example.com.";
  if (typeof input.phone === "string" && input.phone.length > 40) errors.phone = "Use 40 characters or fewer.";
  return errors;
}

export async function book(db: Db, input: BookInput): Promise<BookResult> {
  const errors = checkBooker(input);
  if (Object.keys(errors).length) return { ok: false, reason: "invalid", errors };
  const resource = await resourceById(db, input.resourceId);
  if (!resource || !resource.active) return { ok: false, reason: "not_found" };
  const now = input.now ?? new Date();
  const slot = await openSlotAt(db, resource, input.start, now);
  if (!slot) return { ok: false, reason: "taken" };
  return takeSlot(db, resource, slot, input);
}

/**
 * The transaction alone: lock, re-check in SQL, insert. `book` calls it
 * after the slots.ts check; it is exported so tests can show the SQL holds
 * on its own.
 */
export async function takeSlot(db: Db, resource: Resource, slot: OpenSlot, input: BookInput): Promise<BookResult> {
  const token = newToken();
  const hash = await tokenHash(token);
  const st = settingsOf(resource);
  const start = slot.start.toISOString(), end = slot.end.toISOString();
  const gap = st.bufferBeforeMin + st.bufferAfterMin;
  const zone = isValidZone(input.bookerTimeZone) ? input.bookerTimeZone : null;
  const crew = resource.kind === "crew" ? resource.id : null;

  // Among the members still free once the locks are held, the one whose
  // latest booking was made longest ago (never booked first), then by id.
  const insert = q`
    insert into bookings
      (resource_id, crew_id, starts_at, ends_at, name, email, phone, booker_time_zone, status, answers, manage_token_hash, source)
    select c.id, ${crew}::bigint, ${start}::timestamptz, ${end}::timestamptz, ${input.name.trim()}, ${normalizeEmail(input.email)},
           ${input.phone?.trim() || null}, ${zone}, 'confirmed', ${JSON.stringify(input.answers ?? {})}::jsonb, ${hash}, ${input.source}
    from (
      select r.id from resources r
      where r.id = any(${slot.members}::bigint[]) and r.active
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

  const results = await db.transaction([...locks(slot.members), insert]);
  const row = results[results.length - 1][0];
  if (!row) return { ok: false, reason: "taken" };
  return { ok: true, booking: toBooking(row), token };
}

// ---- the manage link: look up, reschedule, cancel -----------------------------

/** The booking a manage link names, or null (a malformed or unknown token is the same null). */
export async function bookingByToken(db: Db, token: string): Promise<Booking | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const [r] = await db.sql`select * from bookings where manage_token_hash = ${await tokenHash(token)}`;
  return r ? toBooking(r) : null;
}

/** Whose settings a booking keeps: the crew it was booked through, else its own resource. */
export async function settingsResourceFor(db: Db, b: Booking): Promise<Resource | null> {
  return resourceById(db, b.crew_id ?? b.resource_id);
}

export type ChangeResult = { ok: true; booking: Booking } | { ok: false; reason: "not_found" | "closed" | "taken" };

/**
 * Move a confirmed, future booking to another open start, with the same
 * person (a crew booking stays with its member). SEQUENCE rises, so the
 * calendar event and any invite are updated rather than duplicated.
 */
export async function reschedule(db: Db, token: string, newStart: Date, now = new Date()): Promise<ChangeResult> {
  const b = await bookingByToken(db, token);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status !== "confirmed" || b.starts_at <= now) return { ok: false, reason: "closed" };
  const owner = await settingsResourceFor(db, b);
  if (!owner) return { ok: false, reason: "not_found" };
  const slot = await openSlotAt(db, owner, newStart, now, { members: [b.resource_id], exceptBooking: b.id });
  if (!slot) return { ok: false, reason: "taken" };

  const st = settingsOf(owner);
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

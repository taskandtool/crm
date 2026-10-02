// The writes behind the availability editor: weekly hours, time off, slot
// settings, crews and calendars. Every function checks its input and
// returns field errors rather than throwing, so a form can show them next to
// the field. Copy this with admin.tsx's editor into any app that edits
// hours (the CRM); the booking pages pick the change up on their next read.
import type { Db } from "../data/db";
import { normalizeEmail } from "../data/email";
import { checkSettings, isValidZone, parseWallTime, wallToInstant, type Settings } from "./slots";
import { toResource, type Resource } from "./book";

export type Errors = Record<string, string>;
export type Saved<T = null> = { ok: true; value: T } | { ok: false; errors: Errors };

export type HoursWindow = { id: string; weekday: number; start: string; end: string };
export type TimeOff = { id: string; starts_at: Date; ends_at: Date; note: string | null };
export type Calendar = { id: string; resource_id: string; provider: "google" | "microsoft"; external_id: string; receives_bookings: boolean; last_synced_at: Date | null; last_error: string | null };

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const asDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));

export async function weeklyHours(db: Db, resourceId: string): Promise<HoursWindow[]> {
  const rows = await db.sql`
    select id::text as id, weekday, start_local::text as start, end_local::text as "end"
    from availability where resource_id = ${resourceId}::bigint order by weekday, start_local`;
  return rows.map((r) => ({ id: r.id, weekday: Number(r.weekday), start: hhmm(parseWallTime(r.start)), end: hhmm(parseWallTime(r.end)) }));
}

/**
 * Add a window to one weekday. It must start before it ends on the same day
 * (end may be 24:00) and must not overlap another window that day; the
 * overlap test runs in the insert, so two editors cannot both add one.
 */
export async function addWindow(db: Db, resourceId: string, weekday: unknown, start: unknown, end: unknown, by: string): Promise<Saved> {
  const errors: Errors = {};
  const day = Number(weekday);
  const s = parseWallTime(String(start ?? "")), e = parseWallTime(String(end ?? ""));
  if (!Number.isInteger(day) || day < 0 || day > 6) errors.weekday = "Choose a day.";
  if (Number.isNaN(s) || s >= 1440) errors.start = "Enter a start time like 09:00.";
  if (Number.isNaN(e)) errors.end = "Enter an end time like 17:00, or 24:00 for midnight.";
  if (!errors.start && !errors.end && s >= e) errors.end = "End after the start. For hours past midnight, add the rest to the next day.";
  if (Object.keys(errors).length) return { ok: false, errors };
  const endText = e === 1440 ? "24:00" : hhmm(e);
  const rows = await db.sql`
    insert into availability (resource_id, weekday, start_local, end_local, updated_by)
    select ${resourceId}::bigint, ${day}, ${hhmm(s)}::time, ${endText}::time, ${by}
    where not exists (
      select 1 from availability a
      where a.resource_id = ${resourceId}::bigint and a.weekday = ${day}
        and a.start_local < ${endText}::time and a.end_local > ${hhmm(s)}::time)
    returning id`;
  return rows.length ? { ok: true, value: null } : { ok: false, errors: { start: "These hours overlap hours already set for that day." } };
}

export async function removeWindow(db: Db, resourceId: string, windowId: string): Promise<void> {
  await db.sql`delete from availability where id = ${windowId}::bigint and resource_id = ${resourceId}::bigint`;
}

/**
 * A `datetime-local` value ("2026-03-09T09:00") read as a wall time in the
 * resource's zone. A time the clock skips moves forward past the gap; a
 * repeated one takes the earlier instant.
 */
export function localInputToInstant(v: unknown, zone: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/.exec(String(v ?? ""));
  if (!m) return null;
  const min = parseWallTime(m[2]);
  return Number.isNaN(min) ? null : wallToInstant(m[1], min, zone, "forward");
}

export async function timeOffList(db: Db, resourceId: string, from = new Date()): Promise<TimeOff[]> {
  const rows = await db.sql`
    select id::text as id, starts_at, ends_at, note from time_off
    where resource_id = ${resourceId}::bigint and ends_at > ${from.toISOString()}::timestamptz order by starts_at limit 200`;
  return rows.map((r) => ({ id: r.id, starts_at: asDate(r.starts_at), ends_at: asDate(r.ends_at), note: r.note ?? null }));
}

/** Time off from two `datetime-local` values in the resource's zone. */
export async function addTimeOff(db: Db, resource: Resource, starts: unknown, ends: unknown, note: unknown, by: string): Promise<Saved> {
  const errors: Errors = {};
  const s = localInputToInstant(starts, resource.time_zone), e = localInputToInstant(ends, resource.time_zone);
  if (!s) errors.starts = "Enter when the time off starts.";
  if (!e) errors.ends = "Enter when it ends.";
  else if (s && e <= s) errors.ends = "End after the start.";
  const text = typeof note === "string" ? note.trim().slice(0, 500) : "";
  if (Object.keys(errors).length) return { ok: false, errors };
  await db.sql`
    insert into time_off (resource_id, starts_at, ends_at, note, updated_by)
    values (${resource.id}::bigint, ${s!.toISOString()}::timestamptz, ${e!.toISOString()}::timestamptz, ${text || null}, ${by})`;
  return { ok: true, value: null };
}

export async function removeTimeOff(db: Db, resourceId: string, id: string): Promise<void> {
  await db.sql`delete from time_off where id = ${id}::bigint and resource_id = ${resourceId}::bigint`;
}

// ---- the resource itself ------------------------------------------------------

export type ResourceFields = {
  kind?: unknown; name: unknown; slug: unknown; email: unknown; time_zone: unknown;
  duration_min: unknown; interval_min: unknown; buffer_before_min: unknown; buffer_after_min: unknown;
  min_notice_min: unknown; horizon_days: unknown; active?: unknown;
};

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const int = (v: unknown) => (typeof v === "string" && /^\d{1,7}$/.test(v.trim()) ? Number(v) : typeof v === "number" ? v : NaN);

/** Check a resource form; the value is ready to store. */
export function readResource(f: ResourceFields): { ok: true; value: Omit<Resource, "id"> } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const name = typeof f.name === "string" ? f.name.trim() : "";
  if (!name || name.length > 120) errors.name = "Enter a name of up to 120 characters.";
  const slug = typeof f.slug === "string" && f.slug.trim() ? f.slug.trim().toLowerCase() : null;
  if (slug && !SLUG.test(slug)) errors.slug = "Use lowercase letters, digits and hyphens, like intro-call.";
  else if (slug === "manage") errors.slug = "This address is used by the manage links. Choose another.";
  const rawEmail = typeof f.email === "string" ? f.email.trim() : "";
  const email = rawEmail ? normalizeEmail(rawEmail) : null;
  if (rawEmail && !email) errors.email = "Enter an email address like name@example.com.";
  const zone = typeof f.time_zone === "string" ? f.time_zone.trim() : "";
  if (!isValidZone(zone)) errors.time_zone = "Enter a time zone like America/New_York.";
  const st: Settings = {
    durationMin: int(f.duration_min), intervalMin: int(f.interval_min), bufferBeforeMin: int(f.buffer_before_min),
    bufferAfterMin: int(f.buffer_after_min), minNoticeMin: int(f.min_notice_min), horizonDays: int(f.horizon_days),
  };
  for (const problem of checkSettings(st)) {
    const field = problem.split(" ")[0];
    errors[field] = problem.replace(/^\w+ must be/, "Use") + ".";
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      kind: f.kind === "crew" ? "crew" : "person", slug, name, email, time_zone: zone,
      duration_min: st.durationMin, interval_min: st.intervalMin, buffer_before_min: st.bufferBeforeMin,
      buffer_after_min: st.bufferAfterMin, min_notice_min: st.minNoticeMin, horizon_days: st.horizonDays,
      active: f.active === undefined ? true : f.active === "on" || f.active === "1" || f.active === true,
    },
  };
}

export async function createResource(db: Db, f: ResourceFields, by: string, source: string): Promise<Saved<Resource>> {
  const r = readResource(f);
  if (!r.ok) return r;
  const v = r.value;
  const rows = await db.sql`
    insert into resources (kind, slug, name, email, time_zone, duration_min, interval_min, buffer_before_min,
      buffer_after_min, min_notice_min, horizon_days, active, source, updated_by)
    select ${v.kind}, ${v.slug}, ${v.name}, ${v.email}, ${v.time_zone}, ${v.duration_min}, ${v.interval_min}, ${v.buffer_before_min},
      ${v.buffer_after_min}, ${v.min_notice_min}, ${v.horizon_days}, ${v.active}, ${source}, ${by}
    where ${v.slug}::text is null or not exists (select 1 from resources where slug = ${v.slug})
    returning *`;
  return rows.length ? { ok: true, value: toResource(rows[0]) } : { ok: false, errors: { slug: "Another booking page already uses this address." } };
}

/** Save the details and slot settings. The kind (person or crew) does not change. */
export async function saveResource(db: Db, id: string, f: ResourceFields, by: string): Promise<Saved<Resource>> {
  const r = readResource(f);
  if (!r.ok) return r;
  const v = r.value;
  const rows = await db.sql`
    update resources set slug = ${v.slug}, name = ${v.name}, email = ${v.email}, time_zone = ${v.time_zone},
      duration_min = ${v.duration_min}, interval_min = ${v.interval_min}, buffer_before_min = ${v.buffer_before_min},
      buffer_after_min = ${v.buffer_after_min}, min_notice_min = ${v.min_notice_min}, horizon_days = ${v.horizon_days},
      active = ${v.active}, updated_by = ${by}, updated_at = now()
    where id = ${id}::bigint
      and (${v.slug}::text is null or not exists (select 1 from resources o where o.slug = ${v.slug} and o.id <> ${id}::bigint))
    returning *`;
  return rows.length ? { ok: true, value: toResource(rows[0]) } : { ok: false, errors: { slug: "Another booking page already uses this address." } };
}

export async function allResources(db: Db): Promise<Resource[]> {
  return (await db.sql`select * from resources order by active desc, name, id`).map(toResource);
}

export async function crewMembers(db: Db, crewId: string): Promise<Resource[]> {
  return (await db.sql`
    select r.* from resource_members m join resources r on r.id = m.member_id
    where m.crew_id = ${crewId}::bigint order by r.name`).map(toResource);
}

/** Add a person to a crew; a crew is never a member. */
export async function addMember(db: Db, crewId: string, memberId: string): Promise<Saved> {
  const rows = await db.sql`
    insert into resource_members (crew_id, member_id)
    select c.id, p.id from resources c, resources p
    where c.id = ${crewId}::bigint and c.kind = 'crew' and p.id = ${memberId}::bigint and p.kind = 'person'
    on conflict do nothing
    returning crew_id`;
  return rows.length ? { ok: true, value: null } : { ok: false, errors: { member: "Choose a person who is not already in this crew." } };
}

export async function removeMember(db: Db, crewId: string, memberId: string): Promise<void> {
  await db.sql`delete from resource_members where crew_id = ${crewId}::bigint and member_id = ${memberId}::bigint`;
}

// ---- calendars -----------------------------------------------------------------

export async function calendars(db: Db, resourceId?: string): Promise<(Calendar & { resource_name: string })[]> {
  const rows = await db.sql`
    select k.id::text as id, k.resource_id::text as resource_id, k.provider, k.external_id, k.receives_bookings,
           k.last_synced_at, k.last_error, r.name as resource_name
    from calendars k join resources r on r.id = k.resource_id
    where (${resourceId ?? null}::bigint is null or k.resource_id = ${resourceId ?? null}::bigint)
    order by r.name, k.id`;
  return rows.map((r) => ({ ...r, last_synced_at: r.last_synced_at ? asDate(r.last_synced_at) : null }) as Calendar & { resource_name: string });
}

/**
 * Which calendar the sync job reads for this resource. The connection itself
 * (google-calendar or microsoft-calendar) is granted to the app in Task &
 * Tool; this row only says which of its calendars belongs to whom.
 */
export async function addCalendar(db: Db, resourceId: string, provider: unknown, externalId: unknown, by: string): Promise<Saved> {
  const p = provider === "google" || provider === "microsoft" ? provider : null;
  const ext = typeof externalId === "string" && externalId.trim() ? externalId.trim().slice(0, 300) : "primary";
  if (!p) return { ok: false, errors: { provider: "Choose Google or Microsoft." } };
  const rows = await db.sql`
    insert into calendars (resource_id, provider, external_id, updated_by)
    values (${resourceId}::bigint, ${p}, ${ext}, ${by})
    on conflict do nothing returning id`;
  return rows.length ? { ok: true, value: null } : { ok: false, errors: { external_id: "This calendar is already added." } };
}

export async function removeCalendar(db: Db, resourceId: string, id: string): Promise<void> {
  await db.sql`delete from calendars where id = ${id}::bigint and resource_id = ${resourceId}::bigint`;
}

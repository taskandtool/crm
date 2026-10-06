// MACHINE ONLY. The calendar sync job: never import this from a page or
// from code that deploys to the edge. Pages read busy; this fills it.
//
// Run it every 15 minutes as a command job (references/calendar-sync.md):
//   npx tsx src/booking/sync.ts
//
// Each run, in this order:
// 1. Push: confirmed bookings with no calendar event get one (its id is
//    stored); a booking whose SEQUENCE rose since its last push has its event
//    moved (reschedule) or deleted (cancel). Rows are claimed first, so two
//    overlapping runs never push the same booking at once, and every event is
//    named before it is created (eventTag), so a run that dies after the
//    create finds that event next time instead of making a second one.
// 2. Pull: for every calendar row, the events in [now, now + horizon] from
//    Google events.list or Microsoft calendarView replace that calendar's
//    busy rows in one transaction. Our own events are known by their
//    tag and left out, so a booking never blocks itself; the owner's events
//    stay busy, even one at the same time as a booking. A failed fetch keeps
//    the old rows and writes last_error.
//
// Every call goes through the Task & Tool gateway with the machine token
// (data/gateway.ts), to the Google connection's `google-calendar`
// endpoint or the Microsoft connection's `microsoft-calendar`; no OAuth token
// is ever on this machine or at the edge. Events are written
// with no attendees: Google and Microsoft would email the booker from the
// owner's account. Confirmations go through the owner's sender (notify.ts).
import { pathToFileURL } from "node:url";
import { q, type Db } from "../data/db";
import { gatewayFetch } from "../data/gateway";
import { dayBounds } from "./slots";

export const GOOGLE_SLUG = "google-calendar";
export const MICROSOFT_SLUG = "microsoft-calendar";
const GRAPH = "https://graph.microsoft.com";
const DAY = 86_400_000;

/**
 * Calls a vendor path through the gateway:
 * `(slug, path, init) => gatewayFetch(process.env, slug, path, init)`. Its
 * 60-second timeout keeps a hung call well inside the 10-minute push claim,
 * or the next run would re-claim the booking and write its event twice.
 */
export type Gateway = (slug: string, path: string, init?: RequestInit) => Promise<Response>;

/** The JSON body, or an Error saying who refused: Task & Tool (x-tasktool-refusal) or the vendor. */
async function call(gw: Gateway, slug: string, path: string, init?: RequestInit, okStatuses: number[] = []): Promise<any> {
  const res = await gw(slug, path, init);
  const refusal = res.headers.get("x-tasktool-refusal");
  if (refusal) throw new Error(`Task & Tool refused the ${slug} call: ${refusal}${refusal === "needs_reconnect" ? " (the owner must reconnect it)" : ""}`);
  if (okStatuses.includes(res.status)) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${slug} answered ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ---- our events: names chosen before they exist ------------------------------------

/**
 * Every event we write carries a tag: the booking's random `event_key`, "v",
 * and the calendar row's id in hex. It is in the event before the provider
 * answers, so a run that died after the create but before saving the id
 * still finds that event next time, and the pull still knows it is ours.
 *
 * Google: the event id is `<tag>v<sequence in hex>` (base32hex, 0-9 a-v, 5 to
 * 1024 characters; "v" never occurs in the hex parts) and the tag is also a
 * private extended property, which events.list can filter on.
 * Microsoft: the tag is a single-value extended property in our own namespace,
 * and the create's transactionId is `<tag>v<sequence in hex>`.
 */
export function eventTag(eventKey: string, calendarRowId: string | number): string {
  if (!/^[0-9a-f]{5,64}$/.test(eventKey)) throw new Error(`event_key ${JSON.stringify(eventKey)} is not 5 to 64 hex characters`);
  return `${eventKey}v${BigInt(calendarRowId).toString(16)}`;
}
const attemptId = (tag: string, sequence: number) => `${tag}v${sequence.toString(16)}`;
/** The tag inside one of our Google event ids, or null for anyone else's event. */
const tagOfGoogleId = (id: string) => (/^[0-9a-f]+v[0-9a-f]+v[0-9a-f]+$/.test(id) ? id.slice(0, id.lastIndexOf("v")) : null);

export const GOOGLE_TAG = "taskToolBooking";
export const MICROSOFT_TAG = "String {7d3c51e2-4b8a-4f6e-9c21-5e0a8b9d3f47} Name TaskToolBooking";

/** A query string with %20 for spaces: Graph's $filter and $expand want it, not "+". */
const query = (params: Record<string, string>) =>
  Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

// ---- reading busy times --------------------------------------------------------

/** A busy event read from a calendar, with what identifies it as ours or not. */
export type BusyEvent = { id: string; tag: string | null; start: Date; end: Date };

const gEvents = (calendarId: string) => `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

/**
 * Google events.list, recurring events expanded (singleEvents), paged by
 * nextPageToken. Not free/busy: free/busy returns merged intervals with no
 * event ids, so our own event could not be told apart from the owner's
 * meeting at the same time. Cancelled, free (transparent) and declined events
 * are not busy, as free/busy has it. An all-day event covers its dates in the
 * resource's zone.
 */
export async function googleBusy(gw: Gateway, calendarId: string, from: Date, to: Date, zone: string): Promise<BusyEvent[]> {
  const out: BusyEvent[] = [];
  let pageToken = "";
  for (let page = 0; ; page++) {
    if (page >= 100) throw new Error("Google events: more than 100 pages");
    const body = await call(gw, GOOGLE_SLUG, `${gEvents(calendarId)}?${query({
      singleEvents: "true", timeMin: from.toISOString(), timeMax: to.toISOString(), maxResults: "2500",
      fields: "items(id,status,transparency,start,end,attendees(self,responseStatus)),nextPageToken",
      ...(pageToken ? { pageToken } : {}),
    })}`);
    for (const e of body?.items ?? []) {
      if (e.status === "cancelled" || e.transparency === "transparent") continue;
      if (e.attendees?.some((a: { self?: boolean; responseStatus?: string }) => a.self && a.responseStatus === "declined")) continue;
      const span = e.start?.date
        ? { start: dayBounds(e.start.date, zone).start, end: dayBounds(e.end.date, zone).start }
        : { start: new Date(e.start?.dateTime), end: new Date(e.end?.dateTime) };
      if (!(span.end > span.start)) continue;
      out.push({ id: String(e.id), tag: tagOfGoogleId(String(e.id)), ...span });
    }
    if (typeof body?.nextPageToken !== "string") return out;
    pageToken = body.nextPageToken;
  }
}

/** Graph's "2026-10-05T14:00:00.0000000" in UTC (asked for with Prefer: outlook.timezone="UTC"). */
const graphUtc = (s: string) => new Date(s.slice(0, 19) + "Z");

/**
 * Microsoft calendarView (getSchedule refuses personal accounts), with our tag
 * expanded. Pages are followed through @odata.nextLink; free,
 * working-elsewhere and cancelled events are not busy. An all-day event
 * covers its dates in the resource's zone.
 */
export async function microsoftBusy(gw: Gateway, calendarId: string, from: Date, to: Date, zone: string): Promise<BusyEvent[]> {
  const base = calendarId === "primary" ? "/v1.0/me/calendarView" : `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView`;
  let path: string | null = `${base}?${query({
    startDateTime: from.toISOString(), endDateTime: to.toISOString(), $select: "id,start,end,showAs,isCancelled,isAllDay", $top: "100",
    $expand: `singleValueExtendedProperties($filter=id eq '${MICROSOFT_TAG}')`,
  })}`;
  const out: BusyEvent[] = [];
  for (let page = 0; path; page++) {
    if (page >= 100) throw new Error("Microsoft calendarView: more than 100 pages");
    const body = await call(gw, MICROSOFT_SLUG, path, { headers: { Prefer: 'outlook.timezone="UTC"' } });
    for (const e of body?.value ?? []) {
      if (e.isCancelled || e.showAs === "free" || e.showAs === "workingElsewhere") continue;
      const tag = (e.singleValueExtendedProperties ?? []).find((p: { id?: string }) => p.id?.toLowerCase() === MICROSOFT_TAG.toLowerCase())?.value ?? null;
      const span = e.isAllDay
        ? { start: dayBounds(e.start.dateTime.slice(0, 10), zone).start, end: dayBounds(e.end.dateTime.slice(0, 10), zone).start }
        : { start: graphUtc(e.start.dateTime), end: graphUtc(e.end.dateTime) };
      out.push({ id: String(e.id), tag, ...span });
    }
    const next: unknown = body?.["@odata.nextLink"];
    if (typeof next === "string") {
      if (!next.startsWith(GRAPH + "/")) throw new Error("Microsoft nextLink points off graph.microsoft.com");
      path = next.slice(GRAPH.length);
    } else path = null;
  }
  return out;
}

type CalendarRow = { id: string; resource_id: string; provider: "google" | "microsoft"; external_id: string; time_zone: string; horizon_days: number };

/**
 * Pull one calendar into busy; on failure the old rows stay and
 * last_error says why. Our own events are left out by their tag, so a booking
 * never blocks itself, even one whose event id was never saved (the job died
 * between the create and the save). Everything else in the calendar is busy,
 * including the owner's own event at the same time as a booking.
 */
export async function pullCalendar(db: Db, gw: Gateway, k: CalendarRow, now: Date): Promise<string | null> {
  const to = new Date(now.getTime() + (Number(k.horizon_days) + 2) * DAY);
  try {
    const fetched = k.provider === "google"
      ? await googleBusy(gw, k.external_id, now, to, k.time_zone)
      : await microsoftBusy(gw, k.external_id, now, to, k.time_zone);
    // Bookings whose event may be in this calendar and must not count as busy:
    // confirmed ones, and any whose last change is not pushed yet.
    const own = await db.sql`
      select event_key, external_event_id, external_calendar_id::text as external_calendar_id from bookings
      where resource_id = ${k.resource_id}::bigint and event_key is not null
        and (status = 'confirmed' or coalesce(synced_sequence, -1) < sequence)
        and (ends_at > ${now.toISOString()}::timestamptz or coalesce(synced_sequence, -1) < sequence)`;
    const tags = new Set<string>();
    const ids = new Set<string>(); // events written before tags, known only by their saved id
    for (const r of own) {
      if (/^[0-9a-f]{5,64}$/.test(r.event_key)) tags.add(eventTag(r.event_key, k.id));
      if (r.external_event_id && r.external_calendar_id === k.id) ids.add(r.external_event_id);
    }
    const busy = fetched.filter((e) => !(e.tag && tags.has(e.tag)) && !ids.has(e.id));
    await db.transaction([
      q`delete from busy where calendar_id = ${k.id}::bigint`,
      q`insert into busy (calendar_id, starts_at, ends_at)
        select ${k.id}::bigint, s, e from unnest(${busy.map((b) => b.start.toISOString())}::timestamptz[], ${busy.map((b) => b.end.toISOString())}::timestamptz[]) as u(s, e)`,
      q`update calendars set last_synced_at = now(), last_error = null where id = ${k.id}::bigint`,
    ]);
    return null;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    await db.sql`update calendars set last_error = ${msg} where id = ${k.id}::bigint`;
    return msg;
  }
}

// ---- writing bookings into the calendar -------------------------------------------

type Due = {
  id: string; resource_id: string; status: string; starts_at: Date; ends_at: Date; name: string; email: string; phone: string | null;
  type_name: string | null; location_kind: string; location: string | null;
  sequence: number; event_key: string; external_event_id: string | null; external_calendar_id: string | null;
  /** An earlier push may have reached the calendar (it died, or failed): look for its event before creating one. */
  attempted: boolean;
};
type Cal = { id: string; resource_id: string; provider: "google" | "microsoft"; external_id: string; receives_bookings: boolean };

/** What the owner sees in their calendar. Adjust freely; keep the booker out of attendees. */
const WHERE: Record<string, string> = { their_place: "At", our_place: "At", phone: "Call", video: "Join" };

/** What the person's calendar shows: what it is and who, where, and how to reach them. */
export function eventText(b: Pick<Due, "id" | "name" | "email" | "phone" | "type_name" | "location_kind" | "location">): { title: string; details: string; location: string | null } {
  return {
    title: b.type_name ? `${b.type_name}: ${b.name}` : `Booking: ${b.name}`,
    details: [
      `${b.name} <${b.email}>`,
      b.phone ? `Phone: ${b.phone}` : "",
      b.location ? `${WHERE[b.location_kind] ?? "Where"}: ${b.location}` : "",
      `Booking ${b.id}`,
    ].filter(Boolean).join("\n"),
    location: b.location,
  };
}

const msTime = (d: Date) => ({ dateTime: d.toISOString().slice(0, 19), timeZone: "UTC" });
const msEvents = (k: Cal) => (k.external_id === "primary" ? "/v1.0/me/events" : `/v1.0/me/calendars/${encodeURIComponent(k.external_id)}/events`);
// "confirmed" also brings back an event the owner deleted: Google keeps a
// deleted event's id as a cancelled event, and a move must leave it visible.
const gTimes = (b: Due) => ({ start: { dateTime: b.starts_at.toISOString() }, end: { dateTime: b.ends_at.toISOString() }, status: "confirmed" });

/** Our live events for this booking in this calendar, found by tag. */
async function findEvents(gw: Gateway, k: Cal, tag: string): Promise<string[]> {
  if (k.provider === "google") {
    const body = await call(gw, GOOGLE_SLUG, `${gEvents(k.external_id)}?${query({ privateExtendedProperty: `${GOOGLE_TAG}=${tag}`, maxResults: "50", fields: "items(id,status)" })}`);
    // Only ids we chose: a copy the owner made of our event is theirs.
    return (body?.items ?? []).filter((e: { id: string; status?: string }) => e.status !== "cancelled" && tagOfGoogleId(e.id) === tag).map((e: { id: string }) => e.id);
  }
  // The filter covers every calendar in the mailbox, which is what we want: the tag names one calendar row.
  const body = await call(gw, MICROSOFT_SLUG, `/v1.0/me/events?${query({
    $filter: `singleValueExtendedProperties/Any(ep: ep/id eq '${MICROSOFT_TAG}' and ep/value eq '${tag}')`, $select: "id", $top: "50",
  })}`);
  return (body?.value ?? []).map((e: { id: string }) => String(e.id));
}

/** Create the event under the name we chose. Returns its id. */
async function insertEvent(gw: Gateway, k: Cal, b: Due, tag: string): Promise<string> {
  const { title, details, location } = eventText(b);
  if (k.provider === "google") {
    const id = attemptId(tag, b.sequence);
    const event = { summary: title, description: details, ...(location ? { location } : {}), extendedProperties: { private: { [GOOGLE_TAG]: tag } }, ...gTimes(b) };
    const made = await call(gw, GOOGLE_SLUG, gEvents(k.external_id), { method: "POST", body: JSON.stringify({ id, ...event }) }, [409]);
    if (made) return String(made.id ?? id);
    // 409 "The requested identifier already exists": an earlier attempt made it
    // (or the owner deleted it, which keeps the id). Write ours over it.
    const fixed = await call(gw, GOOGLE_SLUG, `${gEvents(k.external_id)}/${id}`, { method: "PATCH", body: JSON.stringify(event) }, [404, 410]);
    if (!fixed) throw new Error(`Google says event ${id} exists but will not update it`);
    return id;
  }
  const body = await call(gw, MICROSOFT_SLUG, msEvents(k), {
    method: "POST",
    body: JSON.stringify({
      subject: title, body: { contentType: "text", content: details }, ...(location ? { location: { displayName: location } } : {}), start: msTime(b.starts_at), end: msTime(b.ends_at), showAs: "busy",
      transactionId: attemptId(tag, b.sequence), singleValueExtendedProperties: [{ id: MICROSOFT_TAG, value: tag }],
    }),
  });
  if (!body?.id) throw new Error("microsoft returned no event id");
  return String(body.id);
}

/** Move the event; false when it is gone (the owner deleted it), so the caller writes a new one. */
async function moveEvent(gw: Gateway, k: Cal, b: Due, eventId: string): Promise<boolean> {
  const id = encodeURIComponent(eventId);
  const body = k.provider === "google"
    ? await call(gw, GOOGLE_SLUG, `${gEvents(k.external_id)}/${id}`, { method: "PATCH", body: JSON.stringify(gTimes(b)) }, [404, 410])
    : await call(gw, MICROSOFT_SLUG, `/v1.0/me/events/${id}`, { method: "PATCH", body: JSON.stringify({ start: msTime(b.starts_at), end: msTime(b.ends_at) }) }, [404]);
  return body !== null;
}

async function deleteEvent(gw: Gateway, k: Cal, eventId: string): Promise<void> {
  const id = encodeURIComponent(eventId);
  // Already gone (the owner deleted it) is done, not an error.
  if (k.provider === "google") await call(gw, GOOGLE_SLUG, `${gEvents(k.external_id)}/${id}`, { method: "DELETE" }, [404, 410]);
  else await call(gw, MICROSOFT_SLUG, `/v1.0/me/events/${id}`, { method: "DELETE" }, [404]);
}

/**
 * The booking's event at the booking's time: the saved one moved, else one an
 * earlier attempt made (found by tag, moved, extras removed), else a new one.
 */
async function placeEvent(gw: Gateway, k: Cal, b: Due, tag: string): Promise<string> {
  if (b.external_event_id && (await moveEvent(gw, k, b, b.external_event_id))) return b.external_event_id;
  if (b.attempted) {
    const [found, ...extra] = await findEvents(gw, k, tag);
    for (const id of extra) await deleteEvent(gw, k, id);
    if (found && (await moveEvent(gw, k, b, found))) return found;
  }
  return insertEvent(gw, k, b, tag);
}

/** Push due bookings to their calendars. Returns one message per failure. */
export async function pushBookings(db: Db, gw: Gateway, now = new Date(), limit = 100): Promise<{ pushed: number; errors: string[] }> {
  // Due: confirmed with no event yet; changed since the last push; or
  // cancelled before an attempt that may have made an event was saved.
  // Claiming fixes the calendar and fills a missing event_key, so a retry
  // after a crash names the same event in the same calendar.
  const due = (await db.sql`
    with due as (
      select b.id, (b.push_claimed_at is not null or b.external_error is not null) as attempted from bookings b
      where ((b.status = 'confirmed' and b.external_event_id is null and b.ends_at > ${now.toISOString()}::timestamptz
              and exists (select 1 from calendars k where k.resource_id = b.resource_id and k.receives_bookings))
          or (b.external_event_id is not null and coalesce(b.synced_sequence, -1) < b.sequence)
          or (b.external_event_id is null and b.status <> 'confirmed' and coalesce(b.synced_sequence, -1) < b.sequence
              and (b.push_claimed_at is not null or b.external_error is not null)))
        and (b.push_claimed_at is null or b.push_claimed_at < now() - interval '10 minutes')
      order by b.starts_at
      limit ${limit}
      for update skip locked)
    update bookings b set push_claimed_at = now(),
      event_key = coalesce(b.event_key, replace(gen_random_uuid()::text, '-', '')),
      external_calendar_id = coalesce(b.external_calendar_id, (
        select k.id from calendars k where k.resource_id = b.resource_id and k.receives_bookings order by k.id limit 1))
    from due where b.id = due.id
    returning b.id::text as id, b.resource_id::text as resource_id, b.status, b.starts_at, b.ends_at, b.name, b.email::text as email,
              b.phone, (select t.name from booking_types t where t.id = b.type_id) as type_name, b.location_kind, b.location,
              b.sequence, b.event_key, b.external_event_id, b.external_calendar_id::text as external_calendar_id, due.attempted`) as Due[];
  if (!due.length) return { pushed: 0, errors: [] };
  const cals = (await db.sql`
    select id::text as id, resource_id::text as resource_id, provider, external_id, receives_bookings from calendars
    where resource_id = any(${[...new Set(due.map((b) => b.resource_id))]}::bigint[]) order by id`) as Cal[];

  let pushed = 0;
  const errors: string[] = [];
  for (const raw of due) {
    const b = { ...raw, starts_at: new Date(raw.starts_at), ends_at: new Date(raw.ends_at), sequence: Number(raw.sequence) };
    const k = cals.find((c) => c.id === b.external_calendar_id);
    try {
      if (!k) {
        // The calendar row was removed: nothing left to update there.
        await db.sql`update bookings set synced_sequence = ${b.sequence}, push_claimed_at = null where id = ${b.id}::bigint`;
        continue;
      }
      const tag = eventTag(b.event_key, k.id);
      // Cancelled removes the event; any other status keeps it at the booking's
      // time (a booking moved and then marked completed keeps its event).
      let eventId = b.external_event_id;
      if (b.status === "cancelled") {
        for (const id of eventId ? [eventId] : await findEvents(gw, k, tag)) await deleteEvent(gw, k, id);
      } else {
        eventId = await placeEvent(gw, k, b, tag);
      }
      await db.sql`
        update bookings set external_event_id = ${eventId}, external_provider = ${eventId ? k.provider : null},
          synced_sequence = ${b.sequence}, push_claimed_at = null, external_error = null
        where id = ${b.id}::bigint`;
      pushed++;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      errors.push(`booking ${b.id}: ${msg}`);
      await db.sql`update bookings set push_claimed_at = null, external_error = ${msg} where id = ${b.id}::bigint`;
    }
  }
  return { pushed, errors };
}

/** One run of the job: push, then pull every calendar of an active resource. */
export async function syncCalendars(db: Db, gw: Gateway, now = new Date()): Promise<{ pushed: number; pulled: number; errors: string[] }> {
  const { pushed, errors } = await pushBookings(db, gw, now);
  const rows = (await db.sql`
    select k.id::text as id, k.resource_id::text as resource_id, k.provider, k.external_id, r.time_zone,
           -- As far ahead as the furthest type this person takes can be booked.
           coalesce((
             select max(t.horizon_days) from booking_type_hosts h join booking_types t on t.id = h.type_id
             where h.resource_id = r.id and t.active), 0) as horizon_days
    from calendars k join resources r on r.id = k.resource_id where r.active order by k.id`) as CalendarRow[];
  let pulled = 0;
  for (const k of rows) {
    const err = await pullCalendar(db, gw, k, now);
    if (err) errors.push(`calendar ${k.id}: ${err}`);
    else pulled++;
  }
  return { pushed, pulled, errors };
}

// `npx tsx src/booking/sync.ts`: one run; exits 1 with the errors so the job's run history shows them.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: pg } = await import("pg");
  const { fromPool } = await import("../data/pg");
  const { fail, machineEnv, misused } = await import("../data/cli.mjs");
  const CMD = "npx tsx src/booking/sync.ts";
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`usage: ${CMD}\n\nPushes bookings to the hosts' connected calendars and pulls their busy times, once. Schedule it every 15 minutes.`);
    process.exit(0);
  }
  if (args.length) misused(`calendar sync: it takes no arguments (given ${args.join(" ")})`, CMD);
  // The machine's settings, so a run by hand from a chat shell sees what the scheduled job sees.
  const env = machineEnv();
  const missing = ["PHOENIX_URL", "MACHINE_TOKEN", "DATABASE_URL"].filter((k) => !env[k]);
  if (missing.length) fail(`calendar sync: ${missing.join(", ")} not set, here or in /home/sprite/.env`, `run it on the machine as a scheduled job: ${CMD}`);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
  try {
    const r = await syncCalendars(fromPool(pool), (slug, path, init) => gatewayFetch(env, slug, path, init));
    console.log(`calendar sync: pushed ${r.pushed} booking${r.pushed === 1 ? "" : "s"}, pulled ${r.pulled} calendar${r.pulled === 1 ? "" : "s"}${r.errors.length ? `, ${r.errors.length} failed` : ""}`);
    for (const e of r.errors) console.error(`  ${e}`);
    if (r.errors.length) console.error("  Try: the booking admin's Calendars page shows each calendar's last error");
    process.exitCode = r.errors.length ? 1 : 0;
  } finally {
    await pool.end();
  }
}

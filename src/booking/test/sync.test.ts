import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySchema } from "../../data/migrate";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import { book, cancelByToken, reschedule, setStatus } from "../book";
import { addWindow, createPerson, createType, setHosts } from "../hours";
import { gatewayFetch } from "../../data/gateway";
import { eventTag, GOOGLE_TAG, MICROSOFT_TAG, syncCalendars, type Gateway } from "../sync";

const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"), "utf8");
const PHX = "https://phoenix.test";
const T = (iso: string) => new Date(iso);
const NOW = T("2026-03-01T00:00:00Z");

type Call = { method: string; url: string; path: string; auth: string | null; prefer: string | null; body: any };

/** A fake fetch: `routes` answers by "METHOD path-prefix"; every call is recorded. */
function fake(routes: Record<string, (c: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    const path = url.slice(`${PHX}/api/machine/gateway`.length);
    const c: Call = { method: init.method ?? "GET", url, path, auth: h.get("authorization"), prefer: h.get("prefer"), body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(" ");
      return m === c.method && path.startsWith(p);
    });
    if (!key) return new Response("no route", { status: 599 });
    return routes[key](c);
  }) as unknown as typeof fetch;
  const env = { PHOENIX_URL: PHX + "/", MACHINE_TOKEN: "mt-1" };
  const gw: Gateway = (slug, path, init) => gatewayFetch(env, slug, path, init, f);
  return { calls, gw };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

const typeOf = (slug: string, horizon: string) => ({
  name: "Site visit", slug, duration_min: "60", interval_min: "60", buffer_before_min: "0", buffer_after_min: "0", min_notice_min: "0",
  horizon_days: horizon, location_kind: "our_place", location: "1 Main St",
});

/** Pat, 09:00 to 17:00 in `zone`, taking one type (`resource`, horizon 30), with one calendar. */
async function setup(s: Scratch, provider: "google" | "microsoft", zone = "UTC") {
  await applySchema(s.db, schema);
  const p = await createPerson(s.db, { name: "Pat", email: "pat@example.com", time_zone: zone }, "o@example.com", "test");
  assert.ok(p.ok);
  for (let d = 0; d < 7; d++) await addWindow(s.db, p.value.id, String(d), "09:00", "17:00", "o@example.com");
  const t = await createType(s.db, typeOf("visit", "30"), "o@example.com", "test");
  assert.ok(t.ok);
  await setHosts(s.db, t.value.id, [p.value.id]);
  const [k] = await s.db.sql`insert into calendars (resource_id, provider, external_id) values (${p.value.id}::bigint, ${provider}, ${provider === "google" ? "pat@example.com" : "primary"}) returning id::text as id`;
  return { resource: t.value, person: p.value, calendarId: k.id as string };
}

const busyRows = async (s: Scratch) =>
  (await s.db.sql`select starts_at, ends_at from busy order by starts_at`).map((r) => [new Date(r.starts_at).toISOString(), new Date(r.ends_at).toISOString()]);

async function withDb(t: { skip: (m: string) => void }, fn: (s: Scratch) => Promise<void>) {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await fn(s);
  } finally {
    await s.drop();
  }
}

type Handler = (c: Call) => Response | Promise<Response>;
const lastSegment = (path: string) => decodeURIComponent(path.split("?")[0].split("/").pop()!);

/**
 * A Google calendar as the sync job sees it: insert (409 on a used id, a
 * deleted one included), patch (status "confirmed" brings a deleted event
 * back), delete (keeps the id as cancelled), and events.list with
 * privateExtendedProperty or a time range. `add` puts in the owner's events.
 */
function googleCalendar() {
  const events = new Map<string, any>();
  let n = 0;
  const routes: Record<string, Handler> = {
    "POST /google-calendar/calendar/v3/calendars/": (c) => {
      const id = c.body.id ?? `owner${++n}`;
      if (events.has(id)) return json({ error: { code: 409, message: "The requested identifier already exists." } }, 409);
      events.set(id, { status: "confirmed", ...c.body, id });
      return json(events.get(id));
    },
    "PATCH /google-calendar/calendar/v3/calendars/": (c) => {
      const e = events.get(lastSegment(c.path));
      if (!e) return json({ error: { code: 404 } }, 404);
      Object.assign(e, c.body);
      return json(e);
    },
    "DELETE /google-calendar/calendar/v3/calendars/": (c) => {
      const e = events.get(lastSegment(c.path));
      if (!e) return json({ error: { code: 404 } }, 404);
      if (e.status === "cancelled") return json({ error: { code: 410 } }, 410);
      e.status = "cancelled";
      return new Response(null, { status: 204 });
    },
    "GET /google-calendar/calendar/v3/calendars/": (c) => {
      const u = new URL(c.url);
      let items = [...events.values()].filter((e) => e.status !== "cancelled");
      const pep = u.searchParams.get("privateExtendedProperty");
      if (pep) {
        const [k, v] = pep.split("=");
        items = items.filter((e) => e.extendedProperties?.private?.[k] === v);
      } else {
        const min = T(u.searchParams.get("timeMin")!), max = T(u.searchParams.get("timeMax")!);
        items = items.filter((e) => T(e.end.dateTime ?? e.end.date) > min && T(e.start.dateTime ?? e.start.date) < max);
      }
      return json({ items });
    },
  };
  const add = (start: string, end: string, extra = {}) => {
    const id = `owner${++n}`;
    events.set(id, { id, status: "confirmed", start: { dateTime: start }, end: { dateTime: end }, ...extra });
    return id;
  };
  return { events, routes, add, ours: () => [...events.values()].filter((e) => e.extendedProperties) };
}

/**
 * A Microsoft calendar: create (no transactionId dedupe, so the job's own
 * lookup is what is tested), the extended-property $filter on /me/events,
 * calendarView with the tag expanded, patch and delete.
 */
function microsoftCalendar() {
  const events = new Map<string, any>();
  let n = 0;
  const tagOf = (e: any) => e.singleValueExtendedProperties?.[0]?.value ?? null;
  const routes: Record<string, Handler> = {
    "GET /microsoft-calendar/v1.0/me/calendarView": () =>
      json({ value: [...events.values()].map((e) => ({ ...e, singleValueExtendedProperties: e.singleValueExtendedProperties ?? [] })) }),
    "GET /microsoft-calendar/v1.0/me/events": (c) => {
      const filter = new URL(c.url).searchParams.get("$filter")!;
      const want = /ep\/value eq '([^']+)'/.exec(filter)![1];
      return json({ value: [...events.values()].filter((e) => tagOf(e) === want).map((e) => ({ id: e.id })) });
    },
    "POST /microsoft-calendar/v1.0/me/events": (c) => {
      const id = `AAMk-${++n}`;
      events.set(id, { ...c.body, id, isCancelled: false, isAllDay: false });
      return json(events.get(id));
    },
    "PATCH /microsoft-calendar/v1.0/me/events/": (c) => {
      const e = events.get(lastSegment(c.path));
      if (!e) return json({ error: { code: "ErrorItemNotFound" } }, 404);
      Object.assign(e, c.body);
      return json(e);
    },
    "DELETE /microsoft-calendar/v1.0/me/events/": (c) =>
      events.delete(lastSegment(c.path)) ? new Response(null, { status: 204 }) : json({ error: { code: "ErrorItemNotFound" } }, 404),
  };
  const add = (start: string, end: string) => {
    const id = `owner-${++n}`;
    events.set(id, { id, start: { dateTime: start, timeZone: "UTC" }, end: { dateTime: end, timeZone: "UTC" }, showAs: "busy", isCancelled: false, isAllDay: false });
    return id;
  };
  return { events, routes, add, ours: () => [...events.values()].filter(tagOf) };
}

/** The process died after the provider made the event: the claim stays and no id was saved. */
const dieAfterCreate = (s: Scratch) => s.db.sql`update bookings set external_event_id = null, synced_sequence = null, push_claimed_at = now()`;
const claimExpires = (s: Scratch) => s.db.sql`update bookings set push_claimed_at = now() - interval '11 minutes'`;

test("event tags are base32hex and name the calendar row", () => {
  const tag = eventTag("0123456789abcdef0123456789abcdef", "26");
  assert.equal(tag, "0123456789abcdef0123456789abcdefv1a");
  assert.match(tag + "v0", /^[0-9a-v]{5,1024}$/, "a valid Google event id");
  assert.throws(() => eventTag("NOT-HEX", "1"));
});

test("Google: events.list through the gateway replaces the calendar's busy rows", (t) =>
  withDb(t, async (s) => {
    const { calendarId } = await setup(s, "google", "America/New_York");
    await s.db.sql`insert into busy (calendar_id, starts_at, ends_at) values (${calendarId}::bigint, '2026-03-05T10:00:00Z', '2026-03-05T11:00:00Z')`;
    const ev = (id: string, start: string, end: string, extra = {}) => ({ id, status: "confirmed", start: { dateTime: start }, end: { dateTime: end }, ...extra });
    const { calls, gw } = fake({
      "GET /google-calendar/calendar/v3/calendars/": (c) =>
        new URL(c.url).searchParams.get("pageToken") === "p2"
          ? json({ items: [ev("c", "2026-03-11T15:00:00Z", "2026-03-11T15:30:00Z"), { id: "d", start: { date: "2026-03-12" }, end: { date: "2026-03-13" } }] })
          : json({
              items: [
                ev("a", "2026-03-09T10:00:00-04:00", "2026-03-09T11:00:00-04:00"),
                ev("free", "2026-03-09T16:00:00Z", "2026-03-09T17:00:00Z", { transparency: "transparent" }),
                ev("gone", "2026-03-10T16:00:00Z", "2026-03-10T17:00:00Z", { status: "cancelled" }),
                ev("no", "2026-03-10T18:00:00Z", "2026-03-10T19:00:00Z", { attendees: [{ self: true, responseStatus: "declined" }] }),
                ev("b", "2026-03-10T12:00:00Z", "2026-03-10T13:30:00Z", { attendees: [{ self: true, responseStatus: "accepted" }] }),
              ],
              nextPageToken: "p2",
            }),
    });
    const r = await syncCalendars(s.db, gw, NOW);
    assert.deepEqual(r, { pushed: 0, pulled: 1, errors: [] });
    assert.equal(calls.length, 2);
    const u = new URL(calls[0].url);
    assert.equal(u.pathname, "/api/machine/gateway/google-calendar/calendar/v3/calendars/pat%40example.com/events");
    assert.equal(calls[0].auth, "Bearer mt-1");
    assert.equal(u.searchParams.get("singleEvents"), "true", "recurring events come back as their instances");
    assert.equal(u.searchParams.get("timeMin"), "2026-03-01T00:00:00.000Z");
    assert.equal(u.searchParams.get("timeMax"), "2026-04-02T00:00:00.000Z", "horizon 30 + 2 days");
    assert.equal(new URL(calls[1].url).searchParams.get("pageToken"), "p2");
    assert.deepEqual(await busyRows(s), [
      ["2026-03-09T14:00:00.000Z", "2026-03-09T15:00:00.000Z"],
      ["2026-03-10T12:00:00.000Z", "2026-03-10T13:30:00.000Z"],
      ["2026-03-11T15:00:00.000Z", "2026-03-11T15:30:00.000Z"],
      ["2026-03-12T04:00:00.000Z", "2026-03-13T04:00:00.000Z"], // all day on 12 March in New York (EDT)
    ]);
    const [k] = await s.db.sql`select last_synced_at, last_error from calendars`;
    assert.ok(k.last_synced_at);
    assert.equal(k.last_error, null);
  }));

test("Google: an error, or a refusal, is stored and the old busy rows stay", (t) =>
  withDb(t, async (s) => {
    const { calendarId } = await setup(s, "google");
    await s.db.sql`insert into busy (calendar_id, starts_at, ends_at) values (${calendarId}::bigint, '2026-03-05T10:00:00Z', '2026-03-05T11:00:00Z')`;
    const missing = fake({ "GET /google-calendar/": () => json({ error: { code: 404, message: "Not Found" } }, 404) });
    const r = await syncCalendars(s.db, missing.gw, NOW);
    assert.equal(r.pulled, 0);
    assert.match(r.errors[0], /404/);
    let [k] = await s.db.sql`select last_synced_at, last_error from calendars`;
    assert.match(k.last_error, /Not Found/);
    assert.equal(k.last_synced_at, null);
    assert.equal((await busyRows(s)).length, 1, "a failed fetch never wipes what we had");

    const refused = fake({ "GET /google-calendar/": () => new Response('{"error":"needs_reconnect"}', { status: 409, headers: { "x-tasktool-refusal": "needs_reconnect" } }) });
    await syncCalendars(s.db, refused.gw, NOW);
    [k] = await s.db.sql`select last_error from calendars`;
    assert.match(k.last_error, /needs_reconnect.*reconnect/);
    assert.equal((await busyRows(s)).length, 1);
  }));

test("Microsoft: calendarView pages through nextLink, in UTC, with our tag expanded, skipping free, cancelled and zero-length", (t) =>
  withDb(t, async (s) => {
    await setup(s, "microsoft", "America/New_York");
    const ev = (start: string, end: string, extra = {}) => ({ id: start, start: { dateTime: start, timeZone: "UTC" }, end: { dateTime: end, timeZone: "UTC" }, showAs: "busy", isCancelled: false, isAllDay: false, ...extra });
    const { calls, gw } = fake({
      "GET /microsoft-calendar/v1.0/me/calendarView": (c) =>
        c.path.includes("skip=")
          ? json({ value: [ev("2026-03-11T15:00:00.0000000", "2026-03-11T15:30:00.0000000", { showAs: "tentative" }), ev("2026-03-12T00:00:00.0000000", "2026-03-13T00:00:00.0000000", { isAllDay: true })] })
          : json({
              value: [
                ev("2026-03-09T14:00:00.0000000", "2026-03-09T15:00:00.0000000"),
                ev("2026-03-09T16:00:00.0000000", "2026-03-09T17:00:00.0000000", { showAs: "free" }),
                ev("2026-03-10T16:00:00.0000000", "2026-03-10T17:00:00.0000000", { isCancelled: true }),
                ev("2026-03-10T18:00:00.0000000", "2026-03-10T19:00:00.0000000", { showAs: "workingElsewhere" }),
                ev("2026-03-10T20:00:00.0000000", "2026-03-10T20:00:00.0000000"), // Outlook allows a start equal to its end
              ],
              "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=x&$skip=100",
            }),
    });
    const r = await syncCalendars(s.db, gw, NOW);
    assert.deepEqual(r.errors, []);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.prefer === 'outlook.timezone="UTC"' && c.auth === "Bearer mt-1"));
    const first = new URL(calls[0].url);
    assert.equal(first.searchParams.get("startDateTime"), "2026-03-01T00:00:00.000Z");
    assert.equal(first.searchParams.get("$expand"), `singleValueExtendedProperties($filter=id eq '${MICROSOFT_TAG}')`);
    assert.ok(!calls[0].url.includes("+"), "spaces are %20 for Graph");
    assert.equal(calls[1].path, "/microsoft-calendar/v1.0/me/calendarView?startDateTime=x&$skip=100");
    assert.deepEqual(await busyRows(s), [
      ["2026-03-09T14:00:00.000Z", "2026-03-09T15:00:00.000Z"],
      ["2026-03-11T15:00:00.000Z", "2026-03-11T15:30:00.000Z"],
      ["2026-03-12T04:00:00.000Z", "2026-03-13T04:00:00.000Z"], // all day on 12 March in New York (EDT)
    ]);
  }));

test("Microsoft: a nextLink off graph.microsoft.com is refused", (t) =>
  withDb(t, async (s) => {
    await setup(s, "microsoft");
    const { gw } = fake({ "GET /microsoft-calendar/": () => json({ value: [], "@odata.nextLink": "https://evil.example/v1.0/x" }) });
    const r = await syncCalendars(s.db, gw, NOW);
    assert.match(r.errors[0], /off graph/);
  }));

test("bookings are written to the calendar under our id, moved, and removed; our own event never blocks us", (t) =>
  withDb(t, async (s) => {
    const { resource, calendarId } = await setup(s, "google");
    const a = await book(s.db, { typeId: resource.id, start: T("2026-03-09T10:00:00Z"), name: "Ann", email: "ann@example.com", source: "website", now: NOW });
    assert.ok(a.ok);
    const g = googleCalendar();
    g.add("2026-03-09T11:00:00Z", "2026-03-09T12:00:00Z"); // the owner's meeting right after it
    const { calls, gw } = fake(g.routes);

    let r = await syncCalendars(s.db, gw, NOW);
    assert.deepEqual([r.pushed, r.errors], [1, []]);
    const insert = calls.find((c) => c.method === "POST")!;
    assert.equal(insert.path, "/google-calendar/calendar/v3/calendars/pat%40example.com/events");
    assert.equal(insert.body.start.dateTime, "2026-03-09T10:00:00.000Z");
    assert.equal(insert.body.attendees, undefined, "no attendees: the provider would email the booker");
    assert.equal(insert.body.summary, "Site visit: Ann", "what it is and who");
    assert.equal(insert.body.location, "1 Main St");
    let [row] = await s.db.sql`select event_key, external_event_id, synced_sequence, push_claimed_at from bookings`;
    const tag = eventTag(row.event_key, calendarId);
    assert.equal(insert.body.id, `${tag}v0`, "the id is ours, chosen before the call");
    assert.deepEqual(insert.body.extendedProperties, { private: { [GOOGLE_TAG]: tag } });
    assert.deepEqual([row.external_event_id, row.synced_sequence, row.push_claimed_at], [`${tag}v0`, 0, null]);
    assert.deepEqual(await busyRows(s), [["2026-03-09T11:00:00.000Z", "2026-03-09T12:00:00.000Z"]], "our booking is cut out; the meeting stays");

    // A second run with nothing new pushes nothing.
    calls.length = 0;
    r = await syncCalendars(s.db, gw, NOW);
    assert.equal(r.pushed, 0);
    assert.ok(!calls.some((c) => c.method !== "GET"));

    // Reschedule: the event is patched, once.
    assert.ok((await reschedule(s.db, a.token, T("2026-03-09T14:00:00Z"), NOW)).ok);
    calls.length = 0;
    r = await syncCalendars(s.db, gw, NOW);
    const patch = calls.filter((c) => c.method === "PATCH");
    assert.equal(patch.length, 1);
    assert.equal(patch[0].path, `/google-calendar/calendar/v3/calendars/pat%40example.com/events/${tag}v0`);
    assert.equal(patch[0].body.start.dateTime, "2026-03-09T14:00:00.000Z");
    assert.deepEqual(await busyRows(s), [["2026-03-09T11:00:00.000Z", "2026-03-09T12:00:00.000Z"]]);

    // Cancel: the event is deleted, once.
    assert.ok((await cancelByToken(s.db, a.token, NOW)).ok);
    calls.length = 0;
    await syncCalendars(s.db, gw, NOW);
    await syncCalendars(s.db, gw, NOW);
    assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);
    [row] = await s.db.sql`select synced_sequence, sequence from bookings`;
    assert.equal(row.synced_sequence, row.sequence);
    assert.equal(g.ours()[0].status, "cancelled");
  }));

test("Google: the job dies after the create; the event is not busy meanwhile and the rerun makes no second one", (t) =>
  withDb(t, async (s) => {
    const { resource } = await setup(s, "google");
    assert.ok((await book(s.db, { typeId: resource.id, start: T("2026-03-09T10:00:00Z"), name: "Ann", email: "ann@example.com", source: "website", now: NOW })).ok);
    const g = googleCalendar();
    const { calls, gw } = fake(g.routes);
    await syncCalendars(s.db, gw, NOW);
    await dieAfterCreate(s);
    g.add("2026-03-09T10:00:00Z", "2026-03-09T11:00:00Z"); // the owner's own event at the same time

    // Still claimed: the push waits, the pull runs. Ours is left out by its id; the owner's stays.
    calls.length = 0;
    let r = await syncCalendars(s.db, gw, NOW);
    assert.deepEqual([r.pushed, r.errors], [0, []]);
    assert.ok(!calls.some((c) => c.method !== "GET"));
    assert.deepEqual(await busyRows(s), [["2026-03-09T10:00:00.000Z", "2026-03-09T11:00:00.000Z"]], "one row: the owner's event, not ours");

    await claimExpires(s);
    r = await syncCalendars(s.db, gw, NOW);
    assert.deepEqual([r.pushed, r.errors], [1, []]);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0, "found by its tag, not created again");
    assert.equal(g.ours().length, 1);
    const [row] = await s.db.sql`select external_event_id, synced_sequence, push_claimed_at from bookings`;
    assert.deepEqual([row.external_event_id, row.synced_sequence, row.push_claimed_at], [g.ours()[0].id, 0, null]);
  }));

test("Google: the job dies after the create, then the booking moves; the one event moves with it", (t) =>
  withDb(t, async (s) => {
    const { resource } = await setup(s, "google");
    const a = await book(s.db, { typeId: resource.id, start: T("2026-03-09T10:00:00Z"), name: "Ann", email: "ann@example.com", source: "website", now: NOW });
    assert.ok(a.ok);
    const g = googleCalendar();
    const { gw } = fake(g.routes);
    await syncCalendars(s.db, gw, NOW);
    await dieAfterCreate(s);
    assert.ok((await reschedule(s.db, a.token, T("2026-03-09T14:00:00Z"), NOW)).ok);
    await claimExpires(s);
    assert.deepEqual((await syncCalendars(s.db, gw, NOW)).errors, []);
    assert.equal(g.ours().length, 1);
    assert.equal(g.ours()[0].start.dateTime, "2026-03-09T14:00:00.000Z");
    assert.deepEqual(await busyRows(s), []);
  }));

test("Google: the job dies after the create, then the booking is cancelled; the event is still removed", (t) =>
  withDb(t, async (s) => {
    const { resource } = await setup(s, "google");
    const a = await book(s.db, { typeId: resource.id, start: T("2026-03-09T10:00:00Z"), name: "Ann", email: "ann@example.com", source: "website", now: NOW });
    assert.ok(a.ok);
    const g = googleCalendar();
    const { gw } = fake(g.routes);
    await syncCalendars(s.db, gw, NOW);
    await dieAfterCreate(s);
    assert.ok((await cancelByToken(s.db, a.token, NOW)).ok);
    await syncCalendars(s.db, gw, NOW);
    assert.deepEqual(await busyRows(s), [], "unpushed cancel: our event is still not busy");
    await claimExpires(s);
    assert.deepEqual((await syncCalendars(s.db, gw, NOW)).errors, []);
    assert.equal(g.ours()[0].status, "cancelled");
    const [row] = await s.db.sql`select synced_sequence, sequence from bookings`;
    assert.equal(row.synced_sequence, row.sequence);
  }));

test("Google: an insert answered 409 (the id exists) takes that event over", (t) =>
  withDb(t, async (s) => {
    const { resource, calendarId } = await setup(s, "google");
    assert.ok((await book(s.db, { typeId: resource.id, start: T("2026-03-09T10:00:00Z"), name: "Ann", email: "ann@example.com", source: "website", now: NOW })).ok);
    const [{ event_key }] = await s.db.sql`select event_key from bookings`;
    const id = `${eventTag(event_key, calendarId)}v0`;
    const g = googleCalendar();
    // An earlier attempt's event, since deleted by the owner (Google keeps the id).
    g.events.set(id, { id, status: "cancelled", start: { dateTime: "2026-03-09T09:00:00Z" }, end: { dateTime: "2026-03-09T09:30:00Z" } });
    const { calls, gw } = fake(g.routes);
    const r = await syncCalendars(s.db, gw, NOW);
    assert.deepEqual([r.pushed, r.errors], [1, []]);
    assert.deepEqual(calls.filter((c) => c.method !== "GET").map((c) => c.method), ["POST", "PATCH"]);
    assert.deepEqual([g.events.get(id).status, g.events.get(id).start.dateTime], ["confirmed", "2026-03-09T10:00:00.000Z"]);
    const [row] = await s.db.sql`select external_event_id from bookings`;
    assert.equal(row.external_event_id, id);
  }));

test("Microsoft: a lost create response, then a rerun, makes one event; the pull reads our tag", (t) =>
  withDb(t, async (s) => {
    const { resource, calendarId } = await setup(s, "microsoft");
    assert.ok((await book(s.db, { typeId: resource.id, start: T("2026-03-09T10:00:00Z"), name: "Ann", email: "ann@example.com", source: "website", now: NOW })).ok);
    const m = microsoftCalendar();
    m.add("2026-03-09T10:00:00.0000000", "2026-03-09T11:00:00.0000000"); // the owner's own event at the same time
    const create = m.routes["POST /microsoft-calendar/v1.0/me/events"];
    let lose = true;
    const { calls, gw } = fake({
      ...m.routes,
      // Microsoft makes the event, but the answer never arrives.
      "POST /microsoft-calendar/v1.0/me/events": async (c) => {
        const res = await create(c);
        if (lose) throw new Error("socket hang up");
        return res;
      },
    });
    let r = await syncCalendars(s.db, gw, NOW);
    assert.match(r.errors[0], /socket hang up/);
    let [row] = await s.db.sql`select event_key, external_event_id, external_error from bookings`;
    assert.equal(row.external_event_id, null);
    const tag = eventTag(row.event_key, calendarId);
    const sent = calls.find((c) => c.method === "POST")!;
    assert.equal(sent.body.transactionId, `${tag}v0`);
    assert.deepEqual(sent.body.singleValueExtendedProperties, [{ id: MICROSOFT_TAG, value: tag }]);
    assert.deepEqual(await busyRows(s), [["2026-03-09T10:00:00.000Z", "2026-03-09T11:00:00.000Z"]], "ours is left out by its tag; the owner's stays");

    lose = false;
    calls.length = 0;
    r = await syncCalendars(s.db, gw, NOW);
    assert.deepEqual([r.pushed, r.errors], [1, []]);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0, "found by the extended property, not created again");
    const lookup = new URL(calls.find((c) => c.path.startsWith("/microsoft-calendar/v1.0/me/events?"))!.url);
    assert.equal(lookup.searchParams.get("$filter"), `singleValueExtendedProperties/Any(ep: ep/id eq '${MICROSOFT_TAG}' and ep/value eq '${tag}')`);
    assert.equal(m.ours().length, 1);
    [row] = await s.db.sql`select external_event_id, external_error from bookings`;
    assert.deepEqual([row.external_event_id, row.external_error], [m.ours()[0].id, null]);
    assert.deepEqual(await busyRows(s), [["2026-03-09T10:00:00.000Z", "2026-03-09T11:00:00.000Z"]]);
  }));

test("Microsoft: the job dies after the create; the rerun makes no second event", (t) =>
  withDb(t, async (s) => {
    const { resource } = await setup(s, "microsoft");
    assert.ok((await book(s.db, { typeId: resource.id, start: T("2026-03-09T10:00:00Z"), name: "Ann", email: "ann@example.com", source: "website", now: NOW })).ok);
    const m = microsoftCalendar();
    const { calls, gw } = fake(m.routes);
    await syncCalendars(s.db, gw, NOW);
    await dieAfterCreate(s);
    await claimExpires(s);
    calls.length = 0;
    assert.deepEqual((await syncCalendars(s.db, gw, NOW)).errors, []);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
    assert.equal(m.ours().length, 1);
  }));

test("a failed push is recorded on the booking and retried next run", (t) =>
  withDb(t, async (s) => {
    const { resource } = await setup(s, "microsoft");
    assert.ok((await book(s.db, { typeId: resource.id, start: T("2026-03-09T10:00:00Z"), name: "Ann", email: "ann@example.com", source: "website", now: NOW })).ok);
    let fail = true;
    const { calls, gw } = fake({
      "POST /microsoft-calendar/v1.0/me/events": () => (fail ? json({ error: { code: "ErrorAccessDenied" } }, 403) : json({ id: "AAMk-1" })),
      "GET /microsoft-calendar/": () => json({ value: [] }),
    });
    let r = await syncCalendars(s.db, gw, NOW);
    assert.match(r.errors[0], /403/);
    let [row] = await s.db.sql`select external_event_id, external_error, push_claimed_at from bookings`;
    assert.deepEqual([row.external_event_id, row.push_claimed_at], [null, null]);
    assert.match(row.external_error, /ErrorAccessDenied/);
    fail = false;
    r = await syncCalendars(s.db, gw, NOW);
    assert.equal(r.pushed, 1);
    const sent = calls.filter((c) => c.method === "POST").pop()!;
    assert.deepEqual(sent.body.start, { dateTime: "2026-03-09T10:00:00", timeZone: "UTC" });
    [row] = await s.db.sql`select external_event_id, external_error from bookings`;
    assert.deepEqual([row.external_event_id, row.external_error], ["AAMk-1", null]);
  }));

test("a person's calendar is read as far ahead as the furthest type they take", (t) =>
  withDb(t, async (s) => {
    const { person } = await setup(s, "google"); // horizon 30
    const longer = await createType(s.db, typeOf("install", "90"), "o@example.com", "test");
    assert.ok(longer.ok);
    await setHosts(s.db, longer.value.id, [person.id]);
    const { calls, gw } = fake({ "GET /google-calendar/calendar/v3/calendars/": () => json({ items: [] }) });
    assert.deepEqual((await syncCalendars(s.db, gw, NOW)).errors, []);
    assert.equal(new URL(calls[calls.length - 1].url).searchParams.get("timeMax"), "2026-06-01T00:00:00.000Z", "90 + 2 days, not the visit's 30");
  }));

test("an event the owner deleted is written again when its booking moves", (t) =>
  withDb(t, async (s) => {
    const { resource } = await setup(s, "microsoft");
    const a = await book(s.db, { typeId: resource.id, start: T("2026-03-09T10:00:00Z"), name: "Ann", email: "ann@example.com", source: "website", now: NOW });
    assert.ok(a.ok);
    const m = microsoftCalendar();
    const { calls, gw } = fake(m.routes);
    await syncCalendars(s.db, gw, NOW);
    m.events.clear(); // the owner deleted it
    assert.ok((await reschedule(s.db, a.token, T("2026-03-09T14:00:00Z"), NOW)).ok);
    const r = await syncCalendars(s.db, gw, NOW);
    assert.deepEqual(r.errors, []);
    const [row] = await s.db.sql`select external_event_id, synced_sequence, sequence from bookings`;
    assert.equal(row.external_event_id, "AAMk-2");
    assert.equal(row.synced_sequence, row.sequence);
    const sent = calls.filter((c) => c.method === "POST").pop()!;
    assert.equal(sent.body.start.dateTime, "2026-03-09T14:00:00");
    assert.match(sent.body.transactionId, /v1$/, "a new transactionId for the new sequence");
  }));

test("a booking moved and then marked completed keeps its event, at the new time", (t) =>
  withDb(t, async (s) => {
    const { resource } = await setup(s, "google");
    const a = await book(s.db, { typeId: resource.id, start: T("2026-03-09T10:00:00Z"), name: "Ann", email: "ann@example.com", source: "website", now: NOW });
    assert.ok(a.ok);
    const g = googleCalendar();
    const { calls, gw } = fake(g.routes);
    await syncCalendars(s.db, gw, NOW);
    assert.ok((await reschedule(s.db, a.token, T("2026-03-09T14:00:00Z"), NOW)).ok);
    assert.ok(await setStatus(s.db, a.booking.id, "completed", "o@example.com")); // 9 March is past by the wall clock
    calls.length = 0;
    await syncCalendars(s.db, gw, NOW);
    assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
    assert.equal(calls.filter((c) => c.method === "PATCH").length, 1);
  }));

test("event_key is filled for every booking, old rows included, and stays put", (t) =>
  withDb(t, async (s) => {
    const { resource } = await setup(s, "google");
    assert.ok((await book(s.db, { typeId: resource.id, start: T("2026-03-09T10:00:00Z"), name: "Ann", email: "ann@example.com", source: "website", now: NOW })).ok);
    assert.ok((await book(s.db, { typeId: resource.id, start: T("2026-03-09T12:00:00Z"), name: "Bo", email: "bo@example.com", source: "website", now: NOW })).ok);
    // Rows from before the column existed get a key when the schema adds it.
    await s.db.sql`alter table bookings drop column event_key`;
    await applySchema(s.db, schema);
    const before = await s.db.sql`select event_key from bookings order by id`;
    assert.ok(before.every((r) => /^[0-9a-f]{32}$/.test(r.event_key)));
    assert.notEqual(before[0].event_key, before[1].event_key);
    await applySchema(s.db, schema);
    assert.deepEqual(await s.db.sql`select event_key from bookings order by id`, before, "running the schema again changes nothing");
  }));

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { applySchema } from "../../data/migrate";
import { book } from "../book";
import { addWindow, createPerson, createType, setHosts } from "../hours";
import { bookingJobs } from "../jobs";
import { pushAfterWrites } from "../sync";
import { withDb } from "./calendar-fixtures";

const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"), "utf8");

/** An execution context as the routing Worker hands it: props, and what waitUntil was given. */
function ctxOf(props: object) {
  const waits: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {}, props } as never, waits };
}

test("the job routes answer only a job", async () => {
  const app = bookingJobs(() => { throw new Error("no database for a refusal"); });
  for (const path of ["/jobs/calendar-sync", "/jobs/booking-reminders"]) {
    const { ctx } = ctxOf({});
    assert.equal((await app.request(path, { method: "POST" }, {}, ctx)).status, 404, path);
  }
});

test("reminders run as a job and answer JSON; the CRM's calendar sync is not mounted where calendars are off", (t) =>
  withDb(t, async (s) => {
    await applySchema(s.db, schema);
    const app = bookingJobs(() => s.db, { calendars: false });
    const { ctx } = ctxOf({ job: "booking-reminders" });
    const res = await app.request("/jobs/booking-reminders", { method: "POST" }, {}, ctx);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, released: 0, sent: 0, none: 0, failed: 0, errors: [] });
    assert.equal((await app.request("/jobs/calendar-sync", { method: "POST" }, {}, ctxOf({ job: "calendar-sync" }).ctx)).status, 404);
  }));

test("a write sends the booking it made to the calendar, through the app's connections, after the response", (t) =>
  withDb(t, async (s) => {
    await applySchema(s.db, schema);
    const p = await createPerson(s.db, { name: "Pat", email: "pat@example.com", time_zone: "UTC" }, "o@example.com", "test");
    assert.ok(p.ok);
    for (let d = 0; d < 7; d++) await addWindow(s.db, p.value.id, String(d), "09:00", "17:00", "o@example.com");
    const ty = await createType(s.db, { name: "Visit", slug: "visit", duration_min: "60", interval_min: "60", buffer_before_min: "0", buffer_after_min: "0", min_notice_min: "0", horizon_days: "30", location_kind: "our_place", location: "1 Main St" }, "o@example.com", "test");
    assert.ok(ty.ok);
    await setHosts(s.db, ty.value.id, [p.value.id]);
    await s.db.sql`insert into calendars (resource_id, provider, connection, external_id) values (${p.value.id}::bigint, 'google', 'google-calendar', 'primary')`;

    // production's connections: the routing Worker's stub
    const sent: string[] = [];
    const TT = {
      fetch: async (url: string, init: RequestInit = {}) => {
        sent.push(`${init.method ?? "GET"} ${url}`);
        return Response.json({ id: JSON.parse(String(init.body ?? "{}")).id ?? "x" });
      },
      list: async () => ({ connections: [{ slug: "google-calendar", provider: "google", service: "calendar", account: "pat@example.com" }] }),
    };
    const app = new Hono();
    app.use("*", pushAfterWrites(() => ({ db: s.db })));
    app.post("/book", async (c) => {
      const start = new Date();
      start.setUTCDate(start.getUTCDate() + 2);
      start.setUTCHours(10, 0, 0, 0);
      const r = await book(s.db, { typeId: ty.value.id, start, name: "Ann", email: "ann@example.com", source: "crm" });
      return c.text(r.ok ? "booked" : "no", r.ok ? 200 : 409);
    });
    app.get("/schedule", (c) => c.text("a read"));

    const read = ctxOf({ tt: TT });
    await app.request("/schedule", {}, { TT }, read.ctx);
    assert.equal(read.waits.length, 0, "a read pushes nothing");

    const write = ctxOf({ tt: TT });
    assert.equal(await (await app.request("/book", { method: "POST" }, { TT }, write.ctx)).text(), "booked");
    await Promise.all(write.waits);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^POST https:\/\/tt\/google-calendar\/calendar\/v3\/calendars\/primary\/events$/);
    const [row] = await s.db.sql`select external_event_id from bookings`;
    assert.ok(row.external_event_id, "the event is on the booking");
  }));

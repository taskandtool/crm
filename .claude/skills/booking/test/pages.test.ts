import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { applySchema } from "../../data/migrate";
import { scratch, why } from "../../data/test/scratch";
import { bookingAdmin } from "../admin";
import { addWindow, createResource } from "../hours";
import { bookingPages, type BookingEvent } from "../public";
import { makeStamp } from "../../data/spam";
import type { Scratch } from "../../data/test/scratch";

const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"), "utf8");
const team = { "x-tasktool-user": "owner@example.com" };
const form = (data: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST", body: new URLSearchParams(data), headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
});

test("a visitor books, sees the time in their zone, downloads the invite, and cancels; the team sees it", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await applySchema(s.db, schema);
    const r = await createResource(s.db, {
      name: "Pat", slug: "intro", email: "pat@example.com", time_zone: "America/New_York", duration_min: "30", interval_min: "30",
      buffer_before_min: "0", buffer_after_min: "0", min_notice_min: "0", horizon_days: "14",
    }, "owner@example.com", "test");
    assert.ok(r.ok);
    for (let d = 0; d < 7; d++) await addWindow(s.db, r.value.id, String(d), "09:00", "17:00", "owner@example.com");

    const events: BookingEvent[] = [];
    const app = new Hono();
    app.route("/book", bookingPages(() => s.db, { base: "/book", domain: "acme.com", css: "/site.css", source: "website", onBooked: (_c, e) => void events.push(e) }));
    app.route("/admin/bookings", bookingAdmin(() => s.db, { base: "/admin/bookings", css: "/site.css", source: "website" }));

    // No tz: the business zone, named, and the script that adds the browser's.
    let res = await app.request("/book/intro");
    let html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Times are in America\/New York/);
    assert.match(html, /resolvedOptions\(\)\.timeZone/);
    // In Kolkata, 09:00 New York is 18:30 or 19:30 depending on the season.
    res = await app.request("/book/intro?tz=Asia/Kolkata");
    html = await res.text();
    assert.match(html, /Times are in Asia\/Kolkata/);
    assert.doesNotMatch(html, /resolvedOptions/);
    const link = /href="(\/book\/intro\/confirm\?start=[^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
    assert.match(link, /tz=Asia%2FKolkata/);
    const start = new URL(link, "http://x").searchParams.get("start")!;

    res = await app.request(link);
    assert.match(await res.text(), /GMT\+5:30/);

    // A bad email comes back with the error next to the field, and nothing stored.
    const _started = await makeStamp("booking:intro", undefined, Date.now() - 10_000);
    res = await app.request("/book/intro", form({ start, tz: "Asia/Kolkata", name: "Ann", email: "nope", _started }));
    assert.equal(res.status, 422);
    assert.match(await res.text(), /id="email-error"/);

    res = await app.request("/book/intro", form({ start, tz: "Asia/Kolkata", name: "Ann", email: "ann@example.com", _started }));
    assert.equal(res.status, 303);
    const manage = res.headers.get("location")!;
    assert.match(manage, /^\/book\/manage\/[A-Za-z0-9_-]{43}\?new=1&tz=Asia%2FKolkata$/);
    assert.equal(events[0].event, "booked");
    assert.match(events[0].manageUrl, /^http:\/\/localhost\/book\/manage\//);

    // The same slot again: taken, back to the day with a notice.
    res = await app.request("/book/intro", form({ start, tz: "Asia/Kolkata", name: "Bo", email: "bo@example.com", _started }));
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location")!, /taken=1/);

    res = await app.request(manage);
    html = await res.text();
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.match(html, /You are booked/);
    assert.match(html, /GMT\+5:30/);

    const token = manage.split("/")[3].split("?")[0];
    res = await app.request(`/book/manage/${token}/invite.ics`);
    const ics = await res.text();
    assert.match(res.headers.get("content-type")!, /text\/calendar/);
    assert.match(ics, /METHOD:PUBLISH\r\n/);
    assert.match(ics, /UID:booking-\d+@acme\.com/);

    // The team sees it; a stranger gets a 404.
    assert.equal((await app.request("/admin/bookings")).status, 404);
    res = await app.request("/admin/bookings", { headers: team });
    assert.match(await res.text(), /ann@example\.com/);

    res = await app.request(`/book/manage/${token}/cancel`, form({ tz: "Asia/Kolkata" }));
    assert.equal(res.status, 303);
    assert.match(await (await app.request(`/book/manage/${token}`)).text(), /This booking is cancelled/);
    assert.match(await (await app.request(`/book/manage/${token}/invite.ics`)).text(), /METHOD:CANCEL\r\n[\s\S]*SEQUENCE:1/);
    assert.equal(events[1].event, "cancelled");
    assert.equal((await app.request("/book/manage/not-a-token")).status, 404);
    // A move after the cancel is refused with 409, on the page.
    res = await app.request(`/book/manage/${token}/reschedule`, form({ start, tz: "Asia/Kolkata" }));
    assert.equal(res.status, 409);
    assert.match(await res.text(), /can no longer be changed/);
    // With no organizer email there is no CANCEL to offer: 404, not a 500.
    await s.db.sql`update resources set email = null where id = ${r.value.id}::bigint`;
    assert.equal((await app.request(`/book/manage/${token}/invite.ics`)).status, 404);

    // The hours editor: a window that ends before it starts is refused next to the field.
    res = await app.request(`/admin/bookings/resources/${r.value.id}/hours`, form({ weekday: "1", start: "17:00", end: "09:00" }, team));
    assert.equal(res.status, 422);
    assert.match(await res.text(), /End after the start/);
    res = await app.request(`/admin/bookings/resources/${r.value.id}/hours`, form({ weekday: "6", start: "18:00", end: "20:00" }, team));
    assert.equal(res.status, 303);
    assert.match(await (await app.request(`/admin/bookings/resources/${r.value.id}`, { headers: team })).text(), /18:00 to 20:00/);
  } finally {
    await s.drop();
  }
});

async function intro(s: Scratch) {
  await applySchema(s.db, schema);
  const r = await createResource(s.db, {
    name: "Pat", slug: "intro", email: "pat@example.com", time_zone: "UTC", duration_min: "30", interval_min: "30",
    buffer_before_min: "0", buffer_after_min: "0", min_notice_min: "0", horizon_days: "14",
  }, "owner@example.com", "website");
  assert.ok(r.ok);
  for (let d = 0; d < 7; d++) await addWindow(s.db, r.value.id, String(d), "00:00", "24:00", "owner@example.com");
  return r.value;
}

/** The first open start on the page, and the confirm form's stamp. */
async function firstSlot(app: Hono) {
  const html = await (await app.request("/book/intro?tz=UTC")).text();
  const link = /href="(\/book\/intro\/confirm\?start=[^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
  const confirm = await (await app.request(link)).text();
  return { start: new URL(link, "http://x").searchParams.get("start")!, confirm, stamp: /name="_started" value="([^"]+)"/.exec(confirm)![1] };
}

test("the confirm form has the spam fields: a filled honeypot or a forged stamp books nothing; too fast asks again", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await intro(s);
    const app = new Hono();
    app.route("/book", bookingPages(() => s.db, { base: "/book", domain: "acme.com", css: "/site.css", source: "website" }));
    const { start, confirm, stamp } = await firstSlot(app);
    assert.match(confirm, /position:absolute;left:-10000px/);
    assert.doesNotMatch(confirm, /company_site|class="hidden"/);

    const who = { start, tz: "UTC", name: "Bot", email: "bot@example.com" };
    const old = await makeStamp("booking:intro", undefined, Date.now() - 10_000);
    let res = await app.request("/book/intro", form({ ...who, _started: old, company_website: "http://spam" }));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/book/intro");
    res = await app.request("/book/intro", form(who)); // no stamp at all
    assert.equal(res.status, 303);
    assert.equal((await s.db.sql`select count(*)::int as n from bookings`)[0].n, 0);

    // The stamp the page just served is too fresh: the form comes back with a new one and nothing is booked.
    res = await app.request("/book/intro", form({ ...who, name: "Ann", _started: stamp }));
    assert.equal(res.status, 422);
    const again = await res.text();
    assert.match(again, /press Book it again/);
    assert.match(again, /value="Ann"/);
    assert.equal((await s.db.sql`select count(*)::int as n from bookings`)[0].n, 0);
  } finally {
    await s.drop();
  }
});

test("afterBook can send the booker on (a deposit); the manage page shows the deposit read from payments", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await intro(s);
    const seen: BookingEvent[] = [];
    let send: string | null = null;
    const app = new Hono();
    app.route("/book", bookingPages(() => s.db, {
      base: "/book", domain: "acme.com", css: "/site.css", source: "website",
      afterBook: (_c, e) => {
        seen.push(e);
        return send;
      },
    }));
    const _started = await makeStamp("booking:intro", undefined, Date.now() - 10_000);

    // Nothing returned: the manage page as usual, and no payments table is no deposit line.
    let { start } = await firstSlot(app);
    let res = await app.request("/book/intro", form({ start, tz: "UTC", name: "Ann", email: "ann@example.com", _started }));
    assert.match(res.headers.get("location")!, /^\/book\/manage\/[A-Za-z0-9_-]{43}\?new=1&tz=UTC$/);
    assert.match(seen[0].manageUrl, /^http:\/\/localhost\/book\/manage\/[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(await (await app.request(res.headers.get("location")!)).text(), /Deposit/);

    // A URL returned: the booker goes there; the booking is made either way.
    send = "https://checkout.stripe.example/c/pay/cs_1";
    ({ start } = await firstSlot(app));
    res = await app.request("/book/intro", form({ start, tz: "UTC", name: "Bo", email: "bo@example.com", _started }));
    assert.equal(res.headers.get("location"), send);
    const manage = new URL(seen[1].manageUrl).pathname;

    // With the payments skill's table, the manage page reads the latest deposit for this booking.
    await s.db.sql`create table payments (id bigserial primary key, ref_type text, ref_id text, kind text, status text not null, created_at timestamptz not null default now())`;
    await s.db.sql`insert into payments (ref_type, ref_id, kind, status) values ('booking', ${seen[1].booking.id}, 'deposit', 'pending')`;
    assert.match(await (await app.request(manage)).text(), /Deposit not confirmed yet/);
    await s.db.sql`update payments set status = 'paid'`;
    assert.match(await (await app.request(manage)).text(), /Deposit paid\./);
    assert.doesNotMatch(await (await app.request(new URL(seen[0].manageUrl).pathname)).text(), /Deposit/);

    // A failing afterBook never loses the booking: the manage page instead.
    const broken = new Hono();
    broken.route("/book", bookingPages(() => s.db, { base: "/book", domain: "acme.com", css: "/site.css", source: "website", afterBook: () => { throw new Error("stripe down"); } }));
    ({ start } = await firstSlot(broken));
    res = await broken.request("/book/intro", form({ start, tz: "UTC", name: "Cy", email: "cy@example.com", _started }));
    assert.match(res.headers.get("location")!, /^\/book\/manage\//);
  } finally {
    await s.drop();
  }
});

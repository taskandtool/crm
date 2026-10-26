import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { html as markup } from "hono/html";
import { applySchema } from "../../data/migrate";
import { scratch, why } from "../../data/test/scratch";
import { bookingAdmin, peopleRoutes, typeRoutes } from "../admin";
import { addWindow, createPerson, createType, setHosts } from "../hours";
import { formatShortDate } from "../slots";
import { bookingPages, type BookingEvent } from "../public";
import { makeStamp } from "../../data/spam";
import type { Scratch } from "../../data/test/scratch";

const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"), "utf8");
const team = { "x-tasktool-user": "owner@example.com" };
const sections = { schedule: "/admin/schedule", services: "/admin/services", team: "/admin/team" };
const form = (data: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST", body: new URLSearchParams(data), headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
});

test("a visitor books, sees the time in their zone, downloads the invite, and cancels; the team sees it", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await applySchema(s.db, schema);
    const r = await createPerson(s.db, { name: "Pat", email: "pat@example.com", time_zone: "America/New_York" }, "owner@example.com", "test");
    assert.ok(r.ok);
    for (let d = 0; d < 7; d++) await addWindow(s.db, r.value.id, String(d), "09:00", "17:00", "owner@example.com");
    const type = await createType(s.db, {
      name: "Intro call", slug: "intro", description: "Twenty minutes to see if we fit.", duration_min: "30", interval_min: "30",
      buffer_before_min: "0", buffer_after_min: "0", min_notice_min: "0", horizon_days: "14", location_kind: "video", location: "https://meet.example/pat",
    }, "owner@example.com", "test");
    assert.ok(type.ok);
    await setHosts(s.db, type.value.id, [r.value.id]);

    const events: BookingEvent[] = [];
    const app = new Hono();
    app.route("/book", bookingPages(() => s.db, { base: "/book", domain: "acme.com", css: "/site.css", source: "website", onBooked: (_c, e) => void events.push(e) }));
    app.route("/admin/schedule", bookingAdmin(() => s.db, { base: "/admin/schedule", css: "/site.css", source: "website", sections }));
    app.route("/admin/services", typeRoutes(() => s.db, { base: "/admin/services", css: "/site.css", source: "website", sections }));
    app.route("/admin/team", peopleRoutes(() => s.db, { base: "/admin/team", css: "/site.css", source: "website", sections }));

    // The list of what can be booked, then the type's page.
    let res = await app.request("/book");
    let html = await res.text();
    assert.match(html, /href="\/book\/intro"/);
    assert.match(html, /Intro call/);
    assert.match(html, /30 min · Video call: the link comes with your confirmation/);
    assert.doesNotMatch(html, /meet\.example/, "the link is for people who booked");
    // No tz: the business zone, named, and the script that adds the browser's.
    res = await app.request("/book/intro");
    html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Times are in New York \(Eastern Time\)/);
    assert.match(html, /resolvedOptions\(\)\.timeZone/);
    // The month as a calendar: open days are links, the first one chosen and its times beside it; nothing earlier to go back to.
    const calendar = html.match(/aria-label="Days with open times"[\s\S]*?<\/nav>/)![0];
    assert.equal((calendar.match(/aria-current="date"/g) ?? []).length, 1);
    assert.ok((calendar.match(/<a href="\/book\/intro\?date=/g) ?? []).length >= 1);
    assert.doesNotMatch(calendar, /aria-label="Earlier month"/);
    assert.match(html, /aria-label="Times on /);
    // In Kolkata, 09:00 New York is 18:30 or 19:30 depending on the season.
    res = await app.request("/book/intro?tz=Asia/Kolkata");
    html = await res.text();
    assert.match(html, /Times are in Kolkata \(India Standard Time\)/);
    assert.doesNotMatch(html, /resolvedOptions/);
    const link = /href="(\/book\/intro\/confirm\?start=[^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
    assert.match(link, /tz=Asia%2FKolkata/);
    const start = new URL(link, "http://x").searchParams.get("start")!;

    res = await app.request(link);
    assert.match(await res.text(), /GMT\+5:30/);

    // A bad email comes back with the error next to the field, and nothing stored.
    const _started = await makeStamp("booking:intro", Date.now() - 10_000);
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
    assert.match(html, /Intro call, with Pat\./);
    assert.match(html, /Video call: https:\/\/meet\.example\/pat/);

    const token = manage.split("/")[3].split("?")[0];
    res = await app.request(`/book/manage/${token}/invite.ics`);
    const ics = await res.text();
    assert.match(res.headers.get("content-type")!, /text\/calendar/);
    assert.match(ics, /METHOD:PUBLISH\r\n/);
    assert.match(ics, /UID:booking-\d+@acme\.com/);
    assert.match(ics, /SUMMARY:Intro call with Pat/);
    assert.match(ics, /LOCATION:https:\/\/meet\.example\/pat/);
    assert.equal(events[0].type.name, "Intro call");
    assert.equal(events[0].host.name, "Pat");

    // The team sees it on the week; a stranger gets a 404.
    const week = `/admin/schedule?date=${start.slice(0, 10)}`;
    assert.equal((await app.request(week)).status, 404);
    html = await (await app.request(week, { headers: team })).text();
    // No page of the app's for it: its name opens its Reschedule, where it can be cancelled too.
    assert.match(html, /href="\/admin\/schedule\/\d+\/reschedule"[^>]*>Ann<\/a><span class="text-ink-2"> · Intro call with Pat/);
    assert.match(html, /Times are in New York/, "the first person's zone");
    // With the business's zone given, the week shows its times in it, not the host's (Pat is in New York).
    const zoned = new Hono();
    zoned.route("/admin/schedule", bookingAdmin(() => s.db, { base: "/admin/schedule", css: "/site.css", source: "website", timeZone: "Asia/Tokyo", sections }));
    assert.match(await (await zoned.request(week, { headers: team })).text(), /Times are in Tokyo/);

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

    // Hours: a window that ends before it starts is refused next to the field; time off is added and shown.
    res = await app.request(`/admin/team/${r.value.id}/hours`, form({ weekday: "1", start: "17:00", end: "09:00" }, team));
    assert.equal(res.status, 422);
    assert.match(await res.text(), /End after the start/);
    res = await app.request(`/admin/team/${r.value.id}/hours`, form({ weekday: "6", start: "18:00", end: "20:00" }, team));
    assert.equal(res.status, 303);
    html = await (await app.request(`/admin/team/${r.value.id}`, { headers: team })).text();
    assert.match(html, /6:00 PM – 8:00 PM/);
    res = await app.request(`/admin/team/${r.value.id}/time-off`, form({ starts: "2030-01-02T00:00", ends: "2030-01-02T23:59", note: "Dentist" }, team));
    assert.equal(res.headers.get("location"), `/admin/team/${r.value.id}?saved=time-off`);
    assert.match(await (await app.request(`/admin/team/${r.value.id}`, { headers: team })).text(), /Dentist/);
    html = await (await app.request("/admin/team", { headers: team })).text();
    assert.match(html, /Pat<\/span>/);
    assert.match(html, /href="\/admin\/team\/new"/, "New team member");

    // Services: a new one, listed once someone takes it; renamed; refused without the address people come to.
    res = await app.request("/admin/services", form({
      name: "Estimate visit", slug: "estimate", location_kind: "their_place", duration_min: "60", interval_min: "60",
      buffer_before_min: "30", buffer_after_min: "30", min_notice_min: "1440", horizon_days: "30", active: "1",
    }, team));
    assert.equal(res.status, 303);
    const typeUrl = res.headers.get("location")!.split("?")[0];
    assert.equal((await app.request("/book/estimate")).status, 200);
    assert.doesNotMatch(await (await app.request("/book")).text(), /Estimate visit/, "nobody takes it yet");
    res = await app.request(`${typeUrl}/hosts`, form({ host: r.value.id }, team));
    assert.equal(res.status, 303);
    assert.match(await (await app.request("/book")).text(), /Estimate visit/);
    res = await app.request(typeUrl, form({
      name: "Free estimate", slug: "estimate", location_kind: "their_place", duration_min: "60", interval_min: "60",
      buffer_before_min: "30", buffer_after_min: "30", min_notice_min: "1440", horizon_days: "30", active: "1",
    }, team));
    assert.equal(res.status, 303);
    assert.match(await (await app.request("/book")).text(), /Free estimate/, "renamed");
    assert.match(await (await app.request(`/admin/team/${r.value.id}`, { headers: team })).text(), /Free estimate</, "on the person's services");
    res = await app.request("/admin/services", form({
      name: "Showroom", slug: "showroom", location_kind: "our_place", location: "", duration_min: "30", interval_min: "30",
      buffer_before_min: "0", buffer_after_min: "0", min_notice_min: "0", horizon_days: "30",
    }, team));
    assert.equal(res.status, 422);
    assert.match(await res.text(), /Enter the address people come to/);

    // The team: a new person, then their hours.
    res = await app.request("/admin/team", form({ name: "Sam", email: "sam@example.com", time_zone: "America/Denver", active: "1" }, team));
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location")!, /^\/admin\/team\/\d+\?saved=created$/);
  } finally {
    await s.drop();
  }
});

async function intro(s: Scratch) {
  await applySchema(s.db, schema);
  const r = await createPerson(s.db, { name: "Pat", email: "pat@example.com", time_zone: "UTC" }, "owner@example.com", "website");
  assert.ok(r.ok);
  for (let d = 0; d < 7; d++) await addWindow(s.db, r.value.id, String(d), "00:00", "24:00", "owner@example.com");
  const type = await createType(s.db, {
    name: "Intro call", slug: "intro", duration_min: "30", interval_min: "30", buffer_before_min: "0", buffer_after_min: "0",
    min_notice_min: "0", horizon_days: "14", location_kind: "phone",
  }, "owner@example.com", "website");
  assert.ok(type.ok);
  await setHosts(s.db, type.value.id, [r.value.id]);
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

    const who = { start, tz: "UTC", name: "Bot", email: "bot@example.com", phone: "555 010 0000" };
    const old = await makeStamp("booking:intro", Date.now() - 10_000);
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
    const _started = await makeStamp("booking:intro", Date.now() - 10_000);

    // Nothing returned: the manage page as usual, and no payments table is no deposit line.
    let { start } = await firstSlot(app);
    let res = await app.request("/book/intro", form({ start, tz: "UTC", name: "Ann", email: "ann@example.com", phone: "555 010 0001", _started }));
    assert.match(res.headers.get("location")!, /^\/book\/manage\/[A-Za-z0-9_-]{43}\?new=1&tz=UTC$/);
    assert.match(seen[0].manageUrl, /^http:\/\/localhost\/book\/manage\/[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(await (await app.request(res.headers.get("location")!)).text(), /Deposit/);

    // A URL returned: the booker goes there; the booking is made either way.
    send = "https://checkout.stripe.example/c/pay/cs_1";
    ({ start } = await firstSlot(app));
    res = await app.request("/book/intro", form({ start, tz: "UTC", name: "Bo", email: "bo@example.com", phone: "555 010 0002", _started }));
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
    res = await broken.request("/book/intro", form({ start, tz: "UTC", name: "Cy", email: "cy@example.com", phone: "555 010 0003", _started }));
    assert.match(res.headers.get("location")!, /^\/book\/manage\//);
  } finally {
    await s.drop();
  }
});

test("in an app's own frame, a booking opens on the app's page, and an event the team scheduled shows by its title", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await intro(s);
    const after: string[] = [];
    const app = new Hono();
    app.route("/schedule", bookingAdmin(() => s.db, {
      base: "/schedule", css: "/crm.css", source: "crm", sections,
      Frame: ({ title, user, children }) => markup`<main data-frame="crm"><h1>${title}</h1><p>${user}</p>${children}</main>`,
      returnTo: (b) => ({ href: `/events/${b.id}`, label: "Event" }),
      afterStatus: (_c, b) => void after.push(b.status),
    }));
    const html = await (await app.request("/schedule", { headers: team })).text();
    assert.match(html, /^<main data-frame="crm"><h1>Schedule<\/h1><p>owner@example\.com<\/p>/);
    assert.doesNotMatch(html, /<html/, "no second document inside the app's");
    // No service, nobody assigned, no email: it shows by its title, and opens the app's page.
    const [{ id }] = await s.db.sql<{ id: string }>`
      insert into bookings (starts_at, ends_at, title, name, location_kind) values ('2026-03-10T15:00:00Z', '2026-03-10T16:00:00Z', 'Walk-in cooler check', 'Hank', 'their_place')
      returning id::text as id`;
    assert.match(await (await app.request("/schedule?date=2026-03-10", { headers: team })).text(), new RegExp(`href="/events/${id}"[^>]*>Hank</a><span class="text-ink-2"> · Walk-in cooler check</span>`));
    const res = await app.request(`/schedule/${id}/status`, form({ status: "cancelled" }, team));
    assert.match(res.headers.get("location")!, new RegExp(`^/events/${id}\\?saved=cancelled$`));
    assert.deepEqual(after, ["cancelled"], "the app hears of the change");
  } finally {
    await s.drop();
  }
});

test("a day for the whole team: a column a person against the hours, the unassigned beside them, two at once side by side, time off; one person picked keeps the list", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await applySchema(s.db, schema);
    const ana = await createPerson(s.db, { name: "Ana", email: "ana@example.com", time_zone: "UTC" }, "owner@example.com", "test");
    const marco = await createPerson(s.db, { name: "Marco", email: "marco@example.com", time_zone: "UTC" }, "owner@example.com", "test");
    assert.ok(ana.ok && marco.ok);
    const job = (who: string | null, from: string, to: string, title: string, name: string) => s.db.sql`
      insert into bookings (resource_id, starts_at, ends_at, title, name, location_kind)
      values (${who}::bigint, ${`2099-03-10T${from}:00Z`}::timestamptz, ${`2099-03-10T${to}:00Z`}::timestamptz, ${title}, ${name}, 'their_place')`;
    await job(ana.value.id, "08:00", "09:00", "Lawn care", "Mei Lin");
    await job(marco.value.id, "13:30", "15:30", "Hedge trim", "Rachel Harper");
    await job(marco.value.id, "14:00", "15:00", "Quote visit", "Ruth Feldman");
    await job(null, "11:00", "11:30", "Walk-in", "Hank");
    await s.db.sql`insert into time_off (resource_id, starts_at, ends_at, note) values (${ana.value.id}::bigint, '2099-03-10T15:00:00Z', '2099-03-10T17:00:00Z', 'Dentist')`;
    const app = new Hono();
    app.route("/schedule", bookingAdmin(() => s.db, { base: "/schedule", css: "/crm.css", source: "crm", sections, timeZone: "UTC" }));

    const html = await (await app.request("/schedule?view=day&date=2099-03-10", { headers: team })).text();
    assert.match(html, /grid-template-columns:4\.5rem repeat\(3, minmax\(11rem, 1fr\)\)/, "Ana, Marco and the unassigned");
    assert.match(html, />Ana<span[^>]*>1<\/span>[\s\S]*>Marco<span[^>]*>2<\/span>[\s\S]*>Not assigned<span[^>]*>1<\/span>/, "each column's count");
    // 7am to 6pm: 8:00 is 60 of 660 minutes down, an hour long.
    assert.match(html, /style="top:9\.091%;height:9\.091%;left:calc\(0% \+ 2px\);width:calc\(100% - 4px\)"[^>]*>[\s\S]*?Mei Lin/);
    assert.match(html, /left:calc\(50% \+ 2px\);width:calc\(50% - 4px\)"[^>]*>[\s\S]*?Ruth Feldman/, "two at once, side by side");
    assert.match(html, />\s*Off: Dentist\s*</);
    assert.match(html, /class="sm:hidden"/, "a phone keeps the list");

    const one = await (await app.request(`/schedule?view=day&date=2099-03-10&person=${ana.value.id}`, { headers: team })).text();
    assert.doesNotMatch(one, /grid-template-columns/, "one person picked: the list");
    assert.match(one, /Mei Lin/);
  } finally {
    await s.drop();
  }
});

test("the team books for someone: carried details, a time, the confirmation sent; the week shows it", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    const pat = await intro(s); // Pat, open all day, UTC; "Intro call" by phone
    const sent: unknown[] = [];
    const app = new Hono();
    app.route("/bookings", bookingAdmin(() => s.db, {
      base: "/bookings", css: "/crm.css", source: "crm", timeZone: "UTC", manageBase: "https://acme.example/book",
      sections: { schedule: "/bookings", services: "/services", team: "/team" },
      onBooked: (_c, e) => void sent.push(e),
    }));
    const who = "name=Joy%20Park&email=joy%40example.com&phone=555%20202%203030";
    let html = await (await app.request(`/bookings/new?${who}`, { headers: team })).text();
    assert.match(html, /Book a time for Joy Park/);
    const typeLink = /href="(\/bookings\/new\/\d+\?[^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
    assert.match(typeLink, /email=joy%40example\.com/, "who it is for travels with the link");
    html = await (await app.request(typeLink, { headers: team })).text();
    const timeLink = /href="(\/bookings\/new\/\d+\/confirm\?[^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
    html = await (await app.request(timeLink, { headers: team })).text();
    assert.match(html, /value="Joy Park"/);
    assert.match(html, /value="555 202 3030"/);
    const typeId = /action="\/bookings\/new\/(\d+)"/.exec(html)![1];
    const start = new URL(timeLink, "http://x").searchParams.get("start")!;

    // A stranger cannot; a missing phone for a phone call is refused next to the field.
    assert.equal((await app.request(`/bookings/new/${typeId}`, form({ start, name: "X", email: "x@example.com" }))).status, 404);
    let res = await app.request(`/bookings/new/${typeId}`, form({ start, name: "Joy Park", email: "joy@example.com" }, team));
    assert.equal(res.status, 422);
    assert.match(await res.text(), /Enter the number we should call/);
    res = await app.request(`/bookings/new/${typeId}`, form({ start, name: "Joy Park", email: "joy@example.com", phone: "555 202 3030", notes: "Prefers mornings" }, team));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/bookings?saved=booked", "with nowhere else to file it, back to the week");
    const [b] = await s.db.sql`select source, location, answers from bookings`;
    assert.deepEqual([b.source, b.location, b.answers], ["crm", "555 202 3030", { notes: "Prefers mornings" }]);
    const e = sent[0] as { host: { id: string }; manageUrl: string };
    assert.equal(e.host.id, pat.id);
    assert.match(e.manageUrl, /^https:\/\/acme\.example\/book\/manage\/[A-Za-z0-9_-]{43}$/);
    // The same time again is taken.
    res = await app.request(`/bookings/new/${typeId}`, form({ start, name: "Bo", email: "bo@example.com", phone: "555 0000" }, team));
    assert.match(await res.text(), /just taken/);

    const week = start.slice(0, 10);
    html = await (await app.request(`/bookings?date=${week}`, { headers: team })).text();
    assert.match(html, /Joy Park<\/a><span class="text-ink-2"> · Intro call with Pat/);
    assert.equal((html.match(/<h3 class=/g) ?? []).length, 7, "seven days");
    assert.match(html, /Phone call: 555 202 3030/, "the team's own words for where");
    const nextWeek = /href="(\/bookings\?date=[\d-]+)"[^>]*aria-label="Week after"/.exec(html)![1];
    assert.doesNotMatch(await (await app.request(nextWeek, { headers: team })).text(), /Joy Park/);
    // Day and Month, as every calendar has: the day alone, and the month's grid with the booking on its day.
    const day = await (await app.request(`/bookings?view=day&date=${week}`, { headers: team })).text();
    assert.equal((day.match(/<h3 class=/g) ?? []).length, 1, "one day");
    assert.match(day, /Joy Park/);
    assert.match(day, /aria-label="Day after"/);
    const month = await (await app.request(`/bookings?view=month&date=${week}`, { headers: team })).text();
    assert.match(month, new RegExp(`aria-label="${formatShortDate(week)}"[\\s\\S]*?Joy Park`), "on its day in the grid");
    assert.match(month, /aria-current="page"[^>]*>Month</);
    assert.match(month, /aria-label="Month after"/);

    // The team reschedules: the calendar leaves out its own time, a time moves it and the booker is told.
    const [joy] = await s.db.sql`select id::text as id, starts_at from bookings where email = 'joy@example.com' and status = 'confirmed'`;
    html = await (await app.request(`/bookings/${joy.id}/reschedule`, { headers: team })).text();
    assert.match(html, /Reschedule Joy Park/);
    assert.match(html, new RegExp(`action="/bookings/${joy.id}/status"`), "it can be cancelled from there");
    const later = [...html.matchAll(/name="start" value="([^"]+)"/g)].map((m) => m[1]).find((v) => v !== start)!;
    assert.equal((await app.request(`/bookings/${joy.id}/reschedule`, form({ start: later }))).status, 404, "team only");
    res = await app.request(`/bookings/${joy.id}/reschedule`, form({ start: later }, team));
    assert.equal(res.headers.get("location"), "/bookings?saved=rescheduled");
    assert.match(await (await app.request("/bookings?saved=rescheduled", { headers: team })).text(), /Booking moved\. They have been told the new time\./, "the Schedule says so");
    const [moved] = await s.db.sql`select starts_at, sequence, updated_by from bookings where id = ${joy.id}::bigint`;
    assert.equal(new Date(moved.starts_at).toISOString(), later);
    assert.equal(moved.updated_by, "owner@example.com");
    assert.equal((sent.at(-1) as { event: string }).event, "rescheduled");
    // A time someone else holds is refused, and nothing moves.
    res = await app.request(`/bookings/${joy.id}/reschedule`, form({ start: "2000-01-01T00:00:00.000Z" }, team));
    assert.equal(res.status, 409);
    assert.match(await res.text(), /just taken/);

    // To another person who takes it: the page offers them, and the move hands it over.
    const sam = await createPerson(s.db, { name: "Sam", email: "sam@example.com", time_zone: "UTC" }, "owner@example.com", "test");
    assert.ok(sam.ok);
    for (let d = 0; d < 7; d++) await addWindow(s.db, sam.value.id, String(d), "00:00", "24:00", "owner@example.com");
    await setHosts(s.db, typeId, [pat.id, sam.value.id]);
    html = await (await app.request(`/bookings/${joy.id}/reschedule?host=${sam.value.id}`, { headers: team })).text();
    assert.match(html, /aria-current="true"[^>]*>Sam</);
    const withSam = [...html.matchAll(/name="start" value="([^"]+)"/g)][0][1];
    assert.match(html, new RegExp(`name="host" value="${sam.value.id}"`));
    res = await app.request(`/bookings/${joy.id}/reschedule`, form({ start: withSam, host: sam.value.id }, team));
    assert.equal(res.headers.get("location"), "/bookings?saved=rescheduled");
    const [handed] = await s.db.sql`select resource_id::text as r from bookings where id = ${joy.id}::bigint`;
    assert.equal(handed.r, sam.value.id);
    assert.equal((sent.at(-1) as { host: { id: string } }).host.id, sam.value.id, "the message names who they now see");

    // The team cancels: the booker is told, as when they cancel themselves.
    res = await app.request(`/bookings/${joy.id}/status`, form({ status: "cancelled" }, team));
    assert.equal(res.headers.get("location"), "/bookings?saved=cancelled");
    assert.equal((sent.at(-1) as { event: string }).event, "cancelled");
  } finally {
    await s.drop();
  }
});


test("a person's Calendars: Show available calendars asks the held accounts, and Attach adds one", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  const realFetch = globalThis.fetch;
  try {
    await applySchema(s.db, schema);
    const pat = await createPerson(s.db, { name: "Pat", email: "pat@example.com", time_zone: "UTC" }, "o@example.com", "test");
    assert.ok(pat.ok);
    const app = new Hono();
    app.route("/admin/team", peopleRoutes(() => s.db, { base: "/admin/team", css: "/site.css", source: "website", sections }));
    const page = `/admin/team/${pat.value.id}`;
    const machine = { PHOENIX_URL: "https://phoenix.test/", MACHINE_TOKEN: "mt-1" };

    // Where the app reaches no connections (a Worker deployed before them), nothing to ask.
    let html = await (await app.request(page, { headers: team })).text();
    assert.match(html, /once this app is deployed again/);
    assert.doesNotMatch(html, /Show available calendars/);
    // On the machine, and in production through the routing Worker's connections.
    assert.match(await (await app.request(page, { headers: team }, machine)).text(), /Show available calendars/);
    const TT = { fetch: async () => new Response("{}"), list: async () => ({ connections: [] }) };
    assert.match(await (await app.request(page, { headers: team }, { TT })).text(), /Show available calendars/);

    // Pat connected their Google; it can also read Sam's calendar.
    globalThis.fetch = (async (url: string) =>
      url.endsWith("/api/machine/connections")
        ? Response.json({ connections: [{ slug: "google-calendar", provider: "google", service: "calendar", account: "pat@example.com" }] })
        : Response.json({
            items: [
              { id: "pat@example.com", summary: "pat@example.com", accessRole: "owner", primary: true },
              { id: "sam@example.com", summary: "sam@example.com", accessRole: "reader" },
            ],
          })) as typeof fetch;
    html = await (await app.request(`${page}/calendars/find`, form({}, team), machine)).text();
    // Pat's own was given to Pat by email on the way; only Sam's is left to attach.
    assert.match(html, /Google · pat@example\.com/);
    assert.equal(html.match(/>Attach</g)?.length, 1);
    assert.match(html, /Through pat@example\.com · busy times only/);

    const res = await app.request(`${page}/calendars`, form({ connection: "google-calendar", external_id: "sam@example.com", name: "sam@example.com", bookings: "0" }, team));
    assert.equal(res.headers.get("location"), `${page}?saved=calendar`);
    html = await (await app.request(page, { headers: team })).text();
    assert.match(html, /Google · sam@example\.com/);
    assert.match(html, /Through pat@example\.com · Busy times only · /);
  } finally {
    globalThis.fetch = realFetch;
    await s.drop();
  }
});

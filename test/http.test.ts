// The app over HTTP with app.request(), against a scratch schema: the
// team-only gate, the pages with real rows, the POSTs, the pipeline's htmx
// answer, the CSV. Skipped without TEST_DATABASE_URL.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import app from "../src/app";
import { cfg } from "../src/config";
import { q, type Db } from "../src/data/db";
import { applySchema } from "../src/data/migrate";
import { setup } from "../src/db/setup";
import { getCustomer } from "../src/crm/customers";
import type { Runtime } from "../src/runtime";
import { scratch, type Scratch } from "./scratch";

const HOST = "https://crm.example";
const ME = { "x-tasktool-user": "Ann@Team.Example", host: "crm.example" };

let s: Scratch | null = null;
let skip: string | false = false;
let db: Db;
let runtime: Runtime;

before(async () => {
  delete process.env.ADMIN_DEV_USER;
  const r = await scratch("http");
  if (typeof r === "string") {
    skip = r;
    return;
  }
  s = r;
  db = r.db;
  await setup(db, cfg.stages);
  await applySchema(db, readFileSync("test/fixtures/other-apps.sql", "utf8"));
  await db.transaction([
    q`insert into forms (key, title) values ('contact', 'Contact us')`,
    q`insert into submissions (form_key, name, email, phone, data, source) values
        ('contact', 'Pat Doe', 'pat@example.com', '555 010 9999', '{"message": "Do you service boilers?"}', 'website')`,
  ]);
  runtime = { open: () => ({ db }) };
});
after(async () => {
  await s?.drop();
});

const get = (path: string, headers: Record<string, string> = ME, rt = runtime) => app.request(HOST + path, { headers }, { runtime: rt });
const post = (path: string, form: Record<string, string>, headers: Record<string, string> = { ...ME, origin: HOST }) =>
  app.request(HOST + path, { method: "POST", body: new URLSearchParams(form), headers: { ...headers, "content-type": "application/x-www-form-urlencoded" } }, { runtime });

test("no identity: 404 everywhere but /healthz", async (t) => {
  if (skip) return t.skip(skip);
  for (const p of ["/", "/customers", "/customers/1", "/customers/export.csv", "/pipeline", "/stages", "/nope"]) {
    assert.equal((await get(p, { host: "crm.example" })).status, 404, p);
  }
  assert.equal((await post("/customers", { name: "x" }, { host: "crm.example", origin: HOST })).status, 404);
  assert.equal((await get("/", { host: "crm.example", "x-tasktool-user": "not an email" })).status, 404);
  const h = await get("/healthz", { host: "crm.example" });
  assert.equal(h.status, 200);
  assert.equal(await h.text(), "ok");
  assert.equal((await get("/healthz", {}, { open: () => ({ db: null, state: "no-url", error: "" }) })).status, 503);
  // A team member before the database is up sees the waiting page, not an error.
  const w = await get("/", ME, { open: () => ({ db: null, state: "no-url", error: "" }) });
  assert.equal(w.status, 503);
  assert.match(await w.text(), /waiting for its database/);
});

test("ADMIN_DEV_USER stands in only on a local request", async (t) => {
  if (skip) return t.skip(skip);
  process.env.ADMIN_DEV_USER = "dev@example.com";
  try {
    assert.equal((await app.request("http://localhost:3000/stages", {}, { runtime })).status, 200);
    assert.equal((await get("/stages", { host: "crm.example" })).status, 404);
    assert.equal((await app.request("http://localhost:3000/stages", { headers: { "x-forwarded-for": "1.2.3.4" } }, { runtime })).status, 404);
  } finally {
    delete process.env.ADMIN_DEV_USER;
  }
});

test("a cross-site POST is refused", async (t) => {
  if (skip) return t.skip(skip);
  const r = await post("/customers", { name: "Mallory" }, { ...ME, origin: "https://evil.example" });
  assert.equal(r.status, 403);
  assert.equal((await db.sql`select 1 from customers where name = 'Mallory'`).length, 0);
});

test("what came in, then Add as customer and Mark done", async (t) => {
  if (skip) return t.skip(skip);
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  assert.match(html, /Contact us/);
  assert.match(html, /Pat Doe/);
  assert.match(html, /Do you service boilers\?/);
  assert.match(html, /Add as customer/);
  assert.doesNotMatch(html, /This project has no/, "every table is there");
  // The filter applies on change with htmx; Apply is the same form without it.
  assert.match(html, /<input type="checkbox" name="unmatched" value="1" hx-get="\/" hx-trigger="change" hx-include="closest form"\/?>/);
  assert.match(html, /<form method="get" action="\/" hx-get="\/" hx-target="#results" hx-swap="outerHTML" hx-push-url="true"/);
  assert.match(html, /<button[^>]*>Apply<\/button>/);
  const filtered = await (await get("/?unmatched=1", { ...ME, "hx-request": "true" })).text();
  assert.ok(filtered.startsWith('<div id="results">'), "htmx gets the results block only");
  assert.match(filtered, /Pat Doe/);
  assert.match(filtered, /name="return" value="\/\?unmatched=1"/, "Mark done comes back to the filter");

  const [sub] = await db.sql<{ id: string }>`select id::text as id from submissions`;
  const add = await post("/inbox/add", { kind: "submission", id: sub.id });
  assert.equal(add.status, 303);
  const loc = add.headers.get("location")!;
  assert.match(loc, /^\/customers\/\d+\?saved=added$/);
  const id = loc.match(/\/customers\/(\d+)/)![1];
  const c = (await getCustomer(db, id))!;
  assert.deepEqual([c.name, c.email, c.source, c.stage, c.created_by], ["Pat Doe", "pat@example.com", "Contact us", "new", "ann@team.example"]);
  assert.match(await (await get("/")).text(), /Open Pat Doe/);

  const done = await post("/inbox/done", { id: sub.id, return: "//evil.example/x" });
  assert.equal(done.headers.get("location"), "/?saved=done", "a return path cannot leave the app");
  const [row] = await db.sql<{ status: string }>`select status from submissions where id = ${sub.id}::bigint`;
  assert.equal(row.status, "done");
});

test("customers: create, open, edit, note, archive", async (t) => {
  if (skip) return t.skip(skip);
  const made = await post("/customers", { name: "Quinn Ray", email: "Quinn@Example.com", phone: "555 123 4567", stage: "contacted" });
  assert.equal(made.status, 303);
  const id = made.headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  const again = await post("/customers", { name: "Q", email: "quinn@example.COM" });
  assert.equal(again.headers.get("location"), `/customers/${id}?saved=exists`);
  assert.equal((await post("/customers", { name: "" })).headers.get("location"), "/customers?saved=name-needed");

  const list = await (await get("/customers?q=quinn")).text();
  assert.match(list, /Quinn Ray/);
  const partial = await (await get("/customers?q=zzz", { ...ME, "hx-request": "true" })).text();
  assert.ok(partial.startsWith('<div id="results">'), "htmx gets the results block only");
  assert.match(partial, /Nothing matches/);

  const detail = await (await get(`/customers/${id}?saved=added`)).text();
  assert.match(detail, /Quinn Ray/);
  assert.match(detail, /Customer added\./);
  assert.match(detail, /Everything from this person/);
  // On a phone the notes come before the long details form, by CSS order only:
  // the markup keeps Details first, and the add-note form is named.
  assert.ok(detail.indexOf(">Details</h2>") < detail.indexOf(">Notes</h2>"));
  assert.match(detail, /<section class="[^"]*\border-first sm:order-none\b[^"]*"><h2[^>]*>Notes<\/h2>/);
  assert.match(detail, /<form method="post" action="\/customers\/\d+\/notes" aria-label="Add a note"/);
  assert.equal((await get("/customers/999999")).status, 404);
  assert.equal((await get("/customers/abc")).status, 404);

  const saved = await post(`/customers/${id}`, { name: "Quinn Ray", email: "quinn@example.com", phone: "555 123 4567", tags: "vip, boiler", owner: "ann@team.example", notes: "Prefers text" });
  assert.equal(saved.headers.get("location"), `/customers/${id}?saved=saved`);
  const c = (await getCustomer(db, id))!;
  assert.deepEqual([c.tags, c.owner, c.notes, c.updated_by], [["vip", "boiler"], "ann@team.example", "Prefers text", "ann@team.example"]);
  const taken = await post(`/customers/${id}`, { name: "Quinn Ray", email: "pat@example.com" });
  assert.equal(taken.headers.get("location"), `/customers/${id}?saved=email-taken`);

  const noted = await post(`/customers/${id}/notes`, { kind: "call", body: "Left a voicemail", at: "2026-10-01T09:15" });
  assert.equal(noted.headers.get("location"), `/customers/${id}?saved=note`);
  assert.match(await (await get(`/customers/${id}`)).text(), /Left a voicemail/);

  assert.equal((await post(`/customers/${id}/archive`, { archived: "1" })).status, 303);
  assert.ok((await getCustomer(db, id))!.archived_at);
  assert.doesNotMatch(await (await get("/customers")).text(), /Quinn Ray/);
  assert.match(await (await get("/customers?show=archived")).text(), /Quinn Ray/);
  await post(`/customers/${id}/archive`, { archived: "0" });
  assert.equal((await getCustomer(db, id))!.archived_at, null);
});

test("pipeline: columns per stage; a stage change answers htmx with the pipeline and a plain post with a 303", async (t) => {
  if (skip) return t.skip(skip);
  const page = await (await get("/pipeline")).text();
  for (const label of ["New", "Contacted", "Won", "Lost"]) assert.match(page, new RegExp(`<section data-stage="[a-z]+" aria-label="${label}, \\d+"`));
  assert.match(page, /Sortable\.min\.js/);
  const [pat] = await db.sql<{ id: string }>`select id::text as id from customers where email = 'pat@example.com'`;
  const hx = await post(`/customers/${pat.id}/stage`, { stage: "won", return: "/pipeline" }, { ...ME, origin: HOST, "hx-request": "true" });
  assert.equal(hx.status, 200);
  const body = await hx.text();
  assert.ok(body.startsWith('<div id="pipeline"'));
  const won = body.split('<section data-stage="won"')[1].split("</section>")[0];
  assert.match(won, /Pat Doe/);
  assert.equal((await getCustomer(db, pat.id))!.stage, "won");

  const plain = await post(`/customers/${pat.id}/stage`, { stage: "contacted", return: "/pipeline" });
  assert.equal(plain.status, 303);
  assert.equal(plain.headers.get("location"), "/pipeline?saved=stage");
  // The card's select posts `status` (admin's StatusForm).
  await post(`/customers/${pat.id}/stage`, { status: "lost", return: "/pipeline" });
  assert.equal((await getCustomer(db, pat.id))!.stage, "lost");
  const bad = await post(`/customers/${pat.id}/stage`, { stage: "nope", return: "/pipeline" });
  assert.equal(bad.headers.get("location"), "/pipeline?saved=pick-stage");
});

test("stages page: add, refuse archiving one in use, archive with a move", async (t) => {
  if (skip) return t.skip(skip);
  assert.match(await (await get("/stages")).text(), /Add a stage/);
  assert.equal((await post("/stages", { label: "Quoted", kind: "open" })).headers.get("location"), "/stages?saved=stage-added");
  const [pat] = await db.sql<{ id: string }>`select id::text as id from customers where email = 'pat@example.com'`;
  await post(`/customers/${pat.id}/stage`, { stage: "quoted" });
  assert.equal((await post("/stages/quoted/archive", {})).headers.get("location"), "/stages?saved=stage-in-use");
  assert.equal((await post("/stages/quoted/archive", { move_to: "won" })).headers.get("location"), "/stages?saved=stage-archived");
  assert.equal((await getCustomer(db, pat.id))!.stage, "won");
  assert.equal((await post("/stages/Bad Key/archive", {})).status, 404);
});

test("CSV export of the filter, with formulas defused", async (t) => {
  if (skip) return t.skip(skip);
  await post("/customers", { name: '=HYPERLINK("http://evil.example","click")', email: "formula@example.com" });
  const r = await get("/customers/export.csv?q=formula");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /text\/csv/);
  const bytes = new Uint8Array(await r.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "a BOM first, so Excel reads UTF-8");
  const text = new TextDecoder().decode(bytes.slice(3));
  assert.ok(text.startsWith("ID,Name,Email"));
  const lines = text.trim().split("\r\n");
  assert.equal(lines.length, 2, "only the filtered row");
  assert.match(lines[1], /,"'=HYPERLINK\(""http:\/\/evil\.example"",""click""\)",formula@example\.com,/);
});

test("visits: add from the customer's page, the list, its page, status, CSV", async (t) => {
  if (skip) return t.skip(skip);
  const made = await post("/customers", { name: "Val Visit", email: "val@example.com", phone: "555 404 0000" });
  const cid = made.headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  const page = await (await get(`/customers/${cid}`)).text();
  assert.match(page, /<h2[^>]*>Visits<\/h2>/);
  assert.match(page, /<a href="\/visits"[^>]*>Visits<\/a>/, "in the nav");
  assert.match(page, /<form method="post" action="\/customers\/\d+\/visits" aria-label="Add a visit"/);

  assert.equal((await post(`/customers/${cid}/visits`, { title: " " })).headers.get("location"), `/customers/${cid}?saved=visit-title-needed`);
  const added = await post(`/customers/${cid}/visits`, { title: "Boiler service", at: "2099-01-15T09:30", status: "planned", owner: "Sam", amount: "$1,245.50" });
  assert.equal(added.status, 303);
  const loc = added.headers.get("location")!;
  assert.match(loc, /^\/visits\/\d+\?saved=visit-added$/);
  const vid = loc.match(/\/visits\/(\d+)/)![1];
  const detail = await (await get(loc)).text();
  assert.match(detail, /Visit added\./);
  assert.match(detail, /value="2099-01-15T09:30"/, "the time back in the business's zone");
  assert.match(detail, /value="1245.50"/);
  assert.match(detail, new RegExp(`<a href="/customers/${cid}">Val Visit</a>`));
  assert.equal((await get("/visits/999999")).status, 404);
  assert.equal((await post(`/customers/999999/visits`, { title: "x" })).status, 404);

  const list = await (await get("/visits")).text();
  assert.match(list, /Boiler service/);
  assert.match(list, /\$1,245\.50/);
  assert.match(await (await get("/visits?q=boiler", { ...ME, "hx-request": "true" })).text(), /^<div id="results">/);

  // A bad amount or time is flagged and keeps what was there; the rest saves.
  const saved = await post(`/visits/${vid}`, { title: "Boiler service and flue check", at: "2099-02-30T09:30", status: "planned", owner: "Sam", amount: "lots" });
  assert.equal(saved.headers.get("location"), `/visits/${vid}?saved=invalid`);
  const after = await (await get(`/visits/${vid}`)).text();
  assert.match(after, /Boiler service and flue check/);
  assert.match(after, /value="2099-01-15T09:30"/);
  assert.match(after, /value="1245.50"/);

  const status = await post(`/visits/${vid}/status`, { status: "done", return: `/visits/${vid}` });
  assert.equal(status.headers.get("location"), `/visits/${vid}?saved=visit-status`);
  assert.equal((await post(`/visits/${vid}/status`, { status: "maybe", return: `/visits/${vid}` })).headers.get("location"), `/visits/${vid}?saved=pick-status`);
  assert.doesNotMatch(await (await get("/visits")).text(), /Boiler service/, "done is not coming up");
  assert.match(await (await get("/visits?view=done")).text(), /Boiler service/);
  assert.ok((await getCustomer(db, cid))!.last_contact_at, "done counts as contact");

  const csv = await get("/visits/export.csv?view=done&q=boiler");
  assert.equal(csv.status, 200);
  const text = new TextDecoder().decode(new Uint8Array(await csv.arrayBuffer()).slice(3));
  const lines = text.trim().split("\r\n");
  assert.equal(lines[0], `ID,Customer,Customer email,Customer phone,What,When (${cfg.time_zone}),Status,Owner,Amount (USD),Notes,Added (UTC)`);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /,Val Visit,val@example\.com,555 404 0000,Boiler service and flue check,\d{4}-\d{2}-\d{2} \d{2}:\d{2},Done,Sam,1245\.50,,/);

  assert.equal((await get("/visits", { host: "crm.example" })).status, 404, "team only");
  assert.equal((await post(`/visits/${vid}/status`, { status: "planned" }, { ...ME, origin: "https://evil.example" })).status, 403);
});

test("bookings in the CRM: its own frame, a type and a person, Make it a job from a booking", async (t) => {
  if (skip) return t.skip(skip);
  let html = await (await get("/bookings/types")).text();
  assert.match(html, /<nav aria-label="CRM"/, "the CRM's own frame");
  assert.match(html, /<a href="\/bookings" aria-current="page"[^>]*>Bookings<\/a>/);
  assert.match(html, /<nav aria-label="Booking"/);
  assert.equal((await get("/bookings/types", { host: "crm.example" })).status, 404, "team only");

  const person = await post("/bookings/people", { name: "Rae", email: "rae@team.example", time_zone: "America/Chicago", active: "1" });
  assert.equal(person.status, 303);
  const personId = person.headers.get("location")!.match(/\/people\/(\d+)/)![1];
  const type = await post("/bookings/types", {
    name: "Estimate visit", slug: "estimate-visit", location_kind: "their_place", duration_min: "60", interval_min: "60",
    buffer_before_min: "30", buffer_after_min: "30", min_notice_min: "120", horizon_days: "30", active: "1",
  });
  assert.equal(type.status, 303);
  const typeId = type.headers.get("location")!.match(/\/types\/(\d+)/)![1];
  assert.equal((await post(`/bookings/types/${typeId}/hosts`, { host: personId })).status, 303);
  assert.match(await (await get(`/bookings/people/${personId}`)).text(), /Estimate visit/);

  // A booking the Website took, then Make it a job from the Jobs page.
  const [b] = await db.sql<{ id: string }>`
    insert into bookings (type_id, resource_id, starts_at, ends_at, name, email, location_kind, location)
    values (${typeId}::bigint, ${personId}::bigint, now() + interval '2 days', now() + interval '2 days 1 hour', 'Lee Wong', 'lee@example.com', 'their_place', '7 Pine St')
    returning id::text as id`;
  html = await (await get("/visits")).text();
  assert.match(html, /Booked, not a visit yet/);
  assert.match(html, /Estimate visit, Lee Wong, with Rae/);
  assert.match(await (await get(`/bookings/${b.id}`)).text(), /Not a customer yet\.[\s\S]*Make it a visit/);
  const made = await post(`/bookings/${b.id}/job`, {});
  assert.equal(made.status, 303);
  const visitUrl = made.headers.get("location")!;
  assert.match(visitUrl, /^\/visits\/\d+\?saved=visit-added$/);
  html = await (await get(visitUrl)).text();
  assert.match(html, /<h1[^>]*>Estimate visit<\/h1>/);
  assert.match(html, />Lee Wong<\/a>/);
  assert.doesNotMatch(await (await get("/visits")).text(), /Lee Wong, with Rae/, "made into a job, it leaves the list");
  assert.match(await (await get(`/bookings/${b.id}`)).text(), /The visit<\/a>/);
  assert.equal((await post(`/bookings/999999/job`, {})).status, 404);

  // From the customer's page, Book a time carries who they are into Book for someone.
  const lee = (await db.sql<{ id: string }>`select id::text as id from customers where email = 'lee@example.com'`)[0].id;
  html = await (await get(`/customers/${lee}`)).text();
  const bookLink = /href="(\/bookings\/new\?[^"]+)">Book a time</.exec(html)![1].replace(/&amp;/g, "&");
  assert.match(bookLink, /name=Lee\+Wong&email=lee%40example\.com/);
  html = await (await get(bookLink)).text();
  assert.match(html, /<h1[^>]*>Book a time for Lee Wong<\/h1>/);
  assert.match(html, /Estimate visit/);
  html = await (await get("/bookings/schedule")).text();
  assert.match(html, /<a href="\/bookings" aria-current="page"[^>]*>Bookings<\/a>/, "inside the CRM's frame");
  assert.match(html, /Times are in UTC\./, "the CRM's zone");
});

// Review regressions.

test("a tampered paging cursor is the first page, not a server error", async (t) => {
  if (skip) return t.skip(skip);
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  for (const p of [`/customers?after=${enc(["2026-02-30 25:00", "1"])}`, `/customers?after=${enc(["yesterday", "1"])}`, `/?after=${enc(["2026-02-30T10:00:00.000000Z", 0, "1"])}`]) {
    assert.equal((await get(p)).status, 200, p);
  }
});

test("a return path that resolves to another site is not followed", async (t) => {
  if (skip) return t.skip(skip);
  for (const ret of ["/.//evil.example", "/a/..//evil.example/x"]) {
    const r = await post("/inbox/done", { id: "1", return: ret });
    assert.equal(r.status, 303);
    assert.ok(!r.headers.get("location")!.startsWith("//"), r.headers.get("location")!);
  }
});

test("production's per-request pool stays open until a long CSV has streamed", async (t) => {
  if (skip) return t.skip(skip);
  await db.sql`insert into customers (name, email, stage) select 'Bulk ' || n, 'bulk' || n || '@example.com', 'new' from generate_series(1, 1203) n`;
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: (s!.pool as unknown as { options: { connectionString: string } }).options.connectionString, max: 2 });
  let closed = false;
  const { fromPool } = await import("../src/data/pg");
  const perRequest: Runtime = { open: () => ({ db: fromPool(pool), close: async () => { closed = true; await pool.end(); } }) };
  const r = await get("/customers/export.csv?q=bulk", ME, perRequest);
  assert.equal(r.status, 200);
  const lines = (await r.text()).trim().split("\r\n");
  assert.equal(lines.length, 1 + 1203, "every page of the export arrived");
  await new Promise((ok) => setTimeout(ok, 50));
  assert.ok(closed, "the pool is closed once the body is sent");
  await db.sql`delete from customers where email like 'bulk%@example.com'`;
});

// The app over HTTP with app.request(), against a scratch schema: the
// team-only gate, the pages with real rows, the POSTs, the pipeline's htmx
// answer, the CSV. Skipped without TEST_DATABASE_URL.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import app from "../src/app";
import { cfg, seeds } from "../src/config";
import { q, type Db } from "../src/data/db";
import { applySchema } from "../src/data/migrate";
import { setup } from "../src/db/setup";
import { getCustomer } from "../src/crm/customers";
import { insertSubmission } from "../src/forms/store";
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
  await setup(db, seeds);
  await applySchema(db, readFileSync("src/forms/schema.sql", "utf8") + ";\n" + readFileSync("src/payments/schema.sql", "utf8"));
  await db.sql`insert into forms (key, title) values ('contact', 'Contact us')`;
  // Through the forms skill, as the Website writes one: Pat is a customer the moment it is in.
  await insertSubmission(db, { form_key: "contact", name: "Pat Doe", email: "pat@example.com", phone: "555 010 9999", data: { message: "Do you service boilers?" }, source: "website", page: null, status: "new" });
  runtime = { open: () => ({ db }) };
});
after(async () => {
  await s?.drop();
});

const get = (path: string, headers: Record<string, string> = ME, rt = runtime) => app.request(HOST + path, { headers }, { runtime: rt });
const post = (path: string, form: Record<string, string>, headers: Record<string, string> = { ...ME, origin: HOST }) =>
  app.request(HOST + path, { method: "POST", body: new URLSearchParams(form), headers: { ...headers, "content-type": "application/x-www-form-urlencoded" } }, { runtime });

test("Stripe's webhook is the one other path without a sign-in, and it wants a signature", async (t) => {
  if (skip) return t.skip(skip);
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_crm_test";
  try {
    const res = await app.request(HOST + "/hooks/stripe", { method: "POST", body: "{}", headers: { host: "crm.example", "stripe-signature": "t=1,v1=00" } }, { runtime });
    assert.equal(res.status, 400);
    assert.equal(await res.text(), "bad signature");
    assert.equal((await app.request(HOST + "/hooks/stripe", { headers: { host: "crm.example" } }, { runtime })).status, 404, "POST only");
    assert.equal((await app.request(HOST + "/hooks/stripe/x", { method: "POST", headers: { host: "crm.example" } }, { runtime })).status, 404);
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
});

test("no identity: 404 everywhere but /healthz", async (t) => {
  if (skip) return t.skip(skip);
  for (const p of ["/", "/customers", "/customers/1", "/customers/export.csv", "/deals", "/deals/1", "/tasks", "/tasks/count", "/stages", "/nope"]) {
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

test("search finds every kind of record: grouped under the box as you type, and as a page", async (t) => {
  if (skip) return t.skip(skip);
  const made = await post("/leads", { name: "Quinn Searchable", phone: "(555) 777-8899", title: "Searchable furnace", source: "phone" });
  const lead = made.headers.get("location")!.match(/\/leads\/(\d+)/)![1];
  const peek = await (await get("/search/peek?q=searchable")).text();
  assert.match(peek, /Contacts[\s\S]*Quinn Searchable[\s\S]*Leads[\s\S]*href="\/leads\/\d+"/, "the contact and the lead, each under its kind");
  assert.match(peek, /href="\/search\?q=searchable"[^>]*>All results/);
  assert.match(await (await get("/search/peek?q=777%208899")).text(), /Quinn Searchable/, "a phone's digits, however written");
  assert.equal(await (await get("/search/peek?q=s")).text(), '<div id="search-peek"></div>', "one letter finds nothing");
  const page = await (await get("/search?q=searchable")).text();
  assert.match(page, new RegExp(`href="/leads/${lead}"`));
  assert.match(page, /href="\/customers\?q=searchable"[^>]*>All contacts/);
  assert.doesNotMatch(page, />All leads</, "the leads list shows one status at a time; search shows every status");
});

test("Home: the figures and the four short lists; the form's person is a contact and their request a lead", async (t) => {
  if (skip) return t.skip(skip);
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  assert.match(html, /<a href="\/" aria-current="page"[^>]*>(?:<svg.*?<\/svg>)?Home<\/a>/);
  for (const label of ["Leads, 7 days", "Your tasks due", "Won this month", "Owed"]) assert.match(html, new RegExp(label));
  assert.match(html, /<h1[^>]*>Good (morning|afternoon|evening)</, "a greeting; no name when all we have is an email");
  assert.match(html, /data-count="\d+"/, "the figures carry the number they count up to");
  for (const [title, link] of [["New leads", "All leads"], ["Today", "Calendar"], ["Your tasks due", "All tasks"], ["Closing this month", "Deals"]]) {
    assert.match(html, new RegExp(`<h2[^>]*>${title}(<span[^>]*>\\d+</span>)?</h2>[\\s\\S]*?>${link}</a>`), title);
  }

  // The submission saved Pat as a contact as it came in, in the first open status, by no one, and made their lead.
  const [sub] = await db.sql<{ id: string }>`select id::text as id from submissions`;
  const [saved] = await db.sql<{ id: string }>`select id::text as id from customers where email = 'pat@example.com'`;
  const c = (await getCustomer(db, saved.id))!;
  assert.deepEqual([c.name, c.email, c.source, c.stage, c.created_by], ["Pat Doe", "pat@example.com", "Contact us", "lead", null]);
  const [lead] = await db.sql<{ id: string }>`select id::text as id from leads where submission_id = ${sub.id}::bigint`;
  assert.match(html, new RegExp(`href="/leads/${lead.id}"[^>]*>Pat Doe<`), "the new lead opens it");
  assert.equal((await db.sql`select 1 from follow_ups where customer_id = ${saved.id}::bigint`).length, 0, "saving them plans nothing: the lead is the reminder");
  assert.equal((await get("/inbox/count")).status, 404, "the Inbox is gone");
});

test("Home's Owed is the open invoices, in the invoices' own currency", async (t) => {
  if (skip) return t.skip(skip);
  const owed = async () => Number((await (await get("/")).text()).match(/>Owed<[\s\S]*?data-count="(\d+)"/)![1]);
  const before = await owed();
  await db.sql`insert into invoices (email, currency, status, livemode, total_cents) values ('owed@example.com', 'usd', 'open', true, 1234500)`;
  assert.equal(await owed() - before, 12345, "whole dollars, in the invoices' usd");
  await db.sql`delete from invoices where email = 'owed@example.com'`;
});

test("the bell: a booker's own move, a quote signed or declined at its link, payments; opening it clears the count", async (t) => {
  if (skip) return t.skip(skip);
  const [b] = await db.sql<{ id: string }>`
    insert into bookings (starts_at, ends_at, name, email, status, location_kind, source)
    values ('2099-05-01 15:00+00', '2099-05-01 16:00+00', 'Rae Fox', 'rae.fox@example.com', 'confirmed', 'our_place', 'website') returning id::text as id`;
  await db.sql`
    insert into booking_changes (booking_id, kind, was_starts_at, starts_at)
    values (${b.id}::bigint, 'rescheduled', '2099-04-30 15:00+00', '2099-05-01 15:00+00')`;
  const [paid] = await db.sql<{ id: string }>`
    insert into quotes (number, email, name, status, currency, total_cents, decided_at, decided_by)
    values ('Q-9001', 'rae.fox@example.com', 'Rae Fox', 'accepted', 'usd', 238000, now(), 'signed online') returning id::text as id`;
  await db.sql`
    insert into quotes (number, email, name, status, currency, total_cents, decided_at, decided_by)
    values ('Q-9003', 'max@example.com', 'Max Bell', 'declined', 'usd', 9000, now(), 'declined online')`;
  await db.sql`
    insert into quotes (number, email, name, status, currency, total_cents, decided_at, decided_by)
    values ('Q-9002', 'rae.fox@example.com', 'Rae Fox', 'accepted', 'usd', 5000, now(), 'ann@team.example')`;
  const [inv] = await db.sql<{ id: string }>`insert into invoices (email, currency, quote_id) values ('rae.fox@example.com', 'usd', ${paid.id}::bigint) returning id::text as id`;
  await db.sql`
    insert into payments (email, name, amount_cents, total_cents, currency, status, kind, ref_type, ref_id, description, livemode) values
      ('rae.fox@example.com', 'Rae Fox', 238000, 238000, 'usd', 'paid', 'invoice', 'invoice', ${inv.id}, 'Invoice for Q-9001', true),
      ('max@example.com', 'Max Bell', 18900, 18900, 'usd', 'paid', 'full', null, null, null, true),
      ('nope@example.com', 'Never Paid', 500, 500, 'usd', 'pending', 'full', null, null, null, true)`;
  // A check the team recorded by hand is theirs, not the customer's doing: not in the bell.
  await db.sql`
    insert into payments (email, name, amount_cents, total_cents, currency, status, kind, ref_type, ref_id, description, livemode, stripe_payment_record_id)
    values ('rae.fox@example.com', 'Rae Fox', 4000, 4000, 'usd', 'paid', 'invoice', 'invoice', ${inv.id}, 'By hand check', true, 'pr_bell_test')`;

  const count = async () => (await (await get("/notifications/count")).text()).match(/>(\d+\+?)<span class="sr-only"> unread/)?.[1] ?? "0";
  assert.equal(await count(), "5");
  const html = await (await get("/notifications")).text();
  assert.match(html, /Rae Fox<\/span> moved <span[^>]*>/, "what they did");
  assert.match(html, new RegExp(`data-href="/events/${b.id}"`), "it opens the booking");
  assert.match(html, /signed Quote Q-9001, \$2,380\.00/);
  assert.doesNotMatch(html, /By hand check/, "a payment the team recorded is not news to them");
  assert.match(html, /declined Quote Q-9003/);
  assert.match(html, new RegExp(`data-href="/invoices/quotes/${paid.id}"`));
  assert.match(html, /Payment of \$189\.00 from <span[^>]*>Max Bell/);
  assert.match(html, /Invoice for Q-9001/, "a quote's invoice paid is a payment like any other");
  assert.doesNotMatch(html, /Q-9002|Never Paid/, "the team's own mark and money that never moved are not news");
  assert.equal((html.match(/Unread: /g) ?? []).length, 5, "what is new since the last look, in bold");

  assert.equal(await count(), "0", "opening the bell saw them");
  assert.doesNotMatch(await (await get("/notifications")).text(), /Unread: /);
  // Read state is each person's own.
  assert.match(await (await get("/notifications/count", { ...ME, "x-tasktool-user": "bo@team.example" })).text(), /5<span class="sr-only"> unread/);
});

test("leads: a form fill and a phone call; convert to a deal, archive with Undo", async (t) => {
  if (skip) return t.skip(skip);
  // A form fill, as the Website writes one: an open lead named for the form.
  const subId = await insertSubmission(db, { form_key: "contact", name: "Lou Park", email: "lou@example.com", phone: null, data: { message: "Need a new water heater" }, source: "website", page: null, status: "new" });
  const [formLead] = await db.sql<{ id: string }>`select id::text as id from leads where submission_id = ${subId}::bigint`;
  const list = await (await get("/leads")).text();
  assert.match(list, /Website form · Contact us/);
  assert.match(list, /Need a new water heater/);
  assert.doesNotMatch(list, /Convert to deal/, "a row opens its lead; no buttons on rows");
  assert.match(await (await get(`/leads/${formLead.id}`)).text(), new RegExp(`>Archive<[\\s\\S]*href="/deals/new\\?from=lead\\.${formLead.id}"[^>]*>Convert to deal<`), "the lead's page: Archive, then Convert, the primary, last");
  assert.match(await (await get("/leads/count")).text(), /\d+<span class="sr-only"> open/);

  // A phone call: New lead finds or adds the contact and opens the lead.
  const made = await post("/leads", { name: "Rae Lin", phone: "(555) 303-4040", title: "Leaking boiler", source: "phone", notes: "Called at 9, wants a visit this week" });
  assert.match(made.headers.get("location")!, /^\/leads\/\d+\?saved=lead-added$/);
  const phoneLead = made.headers.get("location")!.match(/\/leads\/(\d+)/)![1];
  const page = await (await get(`/leads/${phoneLead}`)).text();
  assert.match(page, /Rae Lin/);
  assert.match(page, /Phone/);
  assert.match(page, /Called at 9, wants a visit this week/);
  assert.equal((await db.sql`select 1 from customers where name = 'Rae Lin'`).length, 1, "the contact is made");
  assert.equal((await post("/leads", { name: "", title: "x" })).headers.get("location"), "/leads/new?saved=lead-needs");

  // Archive asks why and offers Undo; Undo opens it again.
  const archived = await post(`/leads/${phoneLead}/archive`, { reason: "Duplicate", return: "/leads" });
  assert.equal(archived.headers.get("location"), `/leads?saved=lead-archived&undo=${phoneLead}`);
  assert.match(await (await get(archived.headers.get("location")!)).text(), new RegExp(`action="/leads/${phoneLead}/reopen"[\\s\\S]*>Undo<`));
  assert.match(await (await get("/leads?status=archived")).text(), /Archived: Duplicate/);
  await post(`/leads/${phoneLead}/reopen`, { return: "/leads" });
  assert.equal((await db.sql<{ status: string }>`select status from leads where id = ${phoneLead}::bigint`)[0].status, "open");

  // A form's lead: its submission follows it (spam, open again), and the submission's page only opens the lead.
  const subStatus = async () => (await db.sql<{ status: string }>`select status from submissions where id = ${subId}::bigint`)[0].status;
  await post(`/leads/${formLead.id}/archive`, { reason: "Spam", return: "/leads" });
  assert.equal(await subStatus(), "spam");
  await post(`/leads/${formLead.id}/reopen`, { return: "/leads" });
  assert.equal(await subStatus(), "read");
  const subPage = await (await get(`/forms/submissions/${subId}`)).text();
  assert.match(subPage, new RegExp(`href="/leads/${formLead.id}"[^>]*>Open lead<`));
  assert.doesNotMatch(subPage, />Mark as spam</, "sorted on the lead, not twice");
  // Nor in bulk: no checkbox on its row, and a bulk move leaves it as its lead has it.
  assert.doesNotMatch(await (await get("/forms/submissions")).text(), new RegExp(`name="id" value="${subId}"`));
  const before = await subStatus();
  await post("/forms/submissions/bulk", { id: String(subId), status: "done" });
  assert.equal(await subStatus(), before, "a lead's submission is not moved in bulk");

  // Convert to deal: the New deal form, filled in from the lead; saving converts it and clears its request.
  const form = await (await get(`/deals/new?from=lead.${formLead.id}`)).text();
  assert.match(form, /name="title" required="" value="Lou Park deal"/, "a form's lead names the deal for the person, as Pipedrive does");
  assert.match(form, /<textarea name="notes"[^>]*>Need a new water heater<\/textarea>/);
  const [lou] = await db.sql<{ id: string }>`select id::text as id from customers where email = 'lou@example.com'`;
  const dealAt = (await post("/deals", { from: `lead.${formLead.id}`, customer: lou.id, title: "Water heater" })).headers.get("location")!;
  const dealId = dealAt.match(/\/deals\/(\d+)/)![1];
  assert.deepEqual(await db.sql`select status, deal_id::text as deal_id from leads where id = ${formLead.id}::bigint`, [{ status: "converted", deal_id: dealId }]);
  assert.equal((await db.sql<{ status: string }>`select status from submissions where id = ${subId}::bigint`)[0].status, "done", "its request is dealt with");
  assert.match(await (await get(`/deals/${dealId}`)).text(), /Where it came from[\s\S]*Website form · Contact us/);

  // Lou asks again while the deal is open: the lead shows the deal they already have.
  const again = await insertSubmission(db, { form_key: "contact", name: "Lou Park", email: "lou@example.com", phone: null, data: { message: "And the softener" }, source: "website", page: null, status: "new" });
  const [second] = await db.sql<{ id: string }>`select id::text as id from leads where submission_id = ${again}::bigint`;
  assert.match(await (await get(`/leads/${second.id}`)).text(), new RegExp(`href="/deals/${dealId}">Water heater`));
  assert.match(await (await get(`/customers/${lou.id}`)).text(), /<h2[^>]*>Leads<span[^>]*>2<\/span><\/h2>[\s\S]*Open[\s\S]*Converted/, "their page lists both leads, and counts them");
  // Its own details are edited on its page, apart from the person's; its header is Convert and Archive.
  const [lead2] = await db.sql<{ id: string }>`select id::text as id from leads where submission_id = ${again}::bigint`;
  let leadPage = await (await get(`/leads/${lead2.id}`)).text();
  assert.match(leadPage, /<h2[^>]*>Details<\/h2>[\s\S]*What they need/);
  assert.doesNotMatch(leadPage.slice(0, leadPage.indexOf("<h2")), />Call</, "reaching them is the contact card's");
  assert.equal((await post(`/leads/${lead2.id}`, { title: "Water softener", owner: "Lou's tech", notes: "Hard water" })).headers.get("location"), `/leads/${lead2.id}?saved=saved`);
  assert.deepEqual(await db.sql`select title, owner::text as owner, notes from leads where id = ${lead2.id}::bigint`, [{ title: "Water softener", owner: "Lou's tech", notes: "Hard water" }]);
  assert.equal((await post(`/leads/${lead2.id}`, { title: "" })).headers.get("location"), `/leads/${lead2.id}?saved=lead-needs`, "it keeps a title");

  // A call from their page: Add lead there makes it theirs.
  const added = await post(`/customers/${lou.id}/leads`, { title: "Softener quote", source: "phone", notes: "Called about hard water" });
  const [phoned] = await db.sql<{ id: string; customer_id: string; source: string }>`select id::text as id, customer_id::text as customer_id, source from leads where title = 'Softener quote'`;
  assert.equal(added.headers.get("location"), `/leads/${phoned.id}?saved=lead-added`);
  assert.deepEqual([phoned.customer_id, phoned.source], [lou.id, "phone"]);
});

test("customers: create, open, edit, note, archive", async (t) => {
  if (skip) return t.skip(skip);
  const made = await post("/customers", { name: "Quinn Ray", email: "Quinn@Example.com", phone: "555 123 4567", stage: "contacted" });
  assert.equal(made.status, 303);
  const id = made.headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  const again = await post("/customers", { name: "Q", email: "quinn@example.COM" });
  assert.equal(again.headers.get("location"), `/customers/${id}?saved=exists`);
  assert.equal((await post("/customers", { name: "" })).headers.get("location"), "/customers/new?saved=name-needed");

  const list = await (await get("/customers?q=quinn")).text();
  assert.match(list, /Quinn Ray/);
  const partial = await (await get("/customers?q=zzz", { ...ME, "hx-request": "true" })).text();
  assert.ok(partial.startsWith('<div id="results">'), "htmx gets the results block only");
  assert.match(partial, /Nothing matches/);

  const detail = await (await get(`/customers/${id}?saved=added`)).text();
  assert.match(detail, /Quinn Ray/);
  assert.match(detail, /Contact added\./);
  // A record page: tasks, then one Activity timeline with its note box, then Details beside them;
  // details are values with Edit, not an open form; nothing empty shows.
  assert.ok(detail.indexOf(">Tasks</h2>") < detail.indexOf(">Activity</h2>"));
  assert.ok(detail.indexOf(">Activity</h2>") < detail.indexOf(">Details</h2>"));
  assert.match(detail, /<form method="post" action="\/customers\/\d+\/notes" aria-label="Log activity"/);
  assert.match(detail, /<summary[^>]*><span[^>]*>Edit<\/span>/);
  assert.doesNotMatch(detail, /Quotes and invoices/, "no quotes or invoices yet, so no section");
  assert.match(detail, /hx-trigger="change"[^>]*>[\s\S]*?name="status"/, "the status saves when chosen");
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

test("deals: the board's columns and totals; a move answers htmx with the board and a plain post with a 303; winning makes them a customer", async (t) => {
  if (skip) return t.skip(skip);
  const [pat] = await db.sql<{ id: string }>`select id::text as id from customers where email = 'pat@example.com'`;
  await db.sql`update customers set stage = 'lead' where id = ${pat.id}::bigint`;
  const made = await post(`/customers/${pat.id}/deals`, { title: "New boiler", value: "4,500", stage: "contacted" });
  assert.match(made.headers.get("location")!, /^\/deals\/\d+\?saved=deal-added$/);
  const dealId = made.headers.get("location")!.match(/\/deals\/(\d+)/)![1];
  assert.match((await post(`/customers/${pat.id}/deals`, { title: "", value: "1" })).headers.get("location")!, /saved=deal-title-needed/);

  // Its page, as Pipedrive's: the open stages as a bar (this one current), Won and Lost to close it.
  const open = await (await get(`/deals/${dealId}`)).text();
  assert.match(open, /<nav aria-label="Stage"[\s\S]*aria-current="step"[^>]*>Contacted</);
  assert.match(open, /name="stage" value="won"[\s\S]*?>Won<\/button>/);
  assert.match(open, /name="stage" value="lost"[\s\S]*?name="lost_reason"[\s\S]*?>Mark lost<\/button>/);
  assert.doesNotMatch(open, />Reopen</);

  const page = await (await get("/deals")).text();
  assert.match(page, /\d+ open · \$/, "the open pipeline under the title");
  for (const label of ["New", "Contacted", "Quote sent", "Won", "Lost"]) assert.match(page, new RegExp(`<section data-stage="[a-z]+" aria-label="${label}, \\d+"`));
  assert.match(page, /Sortable\.min\.js/);
  const contacted = page.split('<section data-stage="contacted"')[1].split("</section>")[0];
  assert.match(contacted, /New boiler/);
  assert.match(contacted, /\$4,500</, "the column's total, to the dollar");
  assert.match(contacted, /data-deal-id=/);

  const hx = await post(`/deals/${dealId}/stage`, { stage: "won", return: "/deals" }, { ...ME, origin: HOST, "hx-request": "true" });
  assert.equal(hx.status, 200);
  const body = await hx.text();
  assert.ok(body.startsWith('<div id="pipeline"'));
  assert.match(body.split('<section data-stage="won"')[1].split("</section>")[0], /New boiler/);
  assert.equal((await getCustomer(db, pat.id))!.stage, "customer", "a won deal makes a lead a customer");

  const plain = await post(`/deals/${dealId}/stage`, { stage: "lost", return: "/deals" });
  assert.equal(plain.headers.get("location"), "/deals?saved=deal-lost", "it says what happened: lost");
  assert.equal((await post(`/deals/${dealId}/stage`, { stage: "won", return: "/deals" })).headers.get("location"), "/deals?saved=deal-won");
  const firstOpen = (await db.sql<{ key: string }>`select key from deal_stages where kind = 'open' and not archived order by position limit 1`)[0].key;
  assert.equal((await post(`/deals/${dealId}/stage`, { stage: firstOpen, return: "/deals" })).headers.get("location"), "/deals?saved=deal-reopened");
  await post(`/deals/${dealId}/stage`, { stage: "lost", return: "/deals" });
  // Why it was lost, said on its page after the move.
  assert.equal((await post(`/deals/${dealId}/stage`, { status: "lost", lost_reason: "Price", return: `/deals/${dealId}` })).headers.get("location"), `/deals/${dealId}?saved=deal-saved`);
  const [d] = await db.sql<{ lost_reason: string; closed: boolean }>`select lost_reason, closed_at is not null as closed from deals where id = ${dealId}::bigint`;
  assert.deepEqual(d, { lost_reason: "Price", closed: true });
  const closedPage = await (await get(`/deals/${dealId}`)).text();
  assert.match(closedPage, /name="stage" value="new"[\s\S]*?>Reopen<\/button>/, "a closed one can be reopened, to the first open stage");
  assert.doesNotMatch(closedPage, /<nav aria-label="Stage"/);
  assert.equal((await getCustomer(db, pat.id))!.stage, "customer", "losing a later deal does not undo who they are");
  const bad = await post(`/deals/${dealId}/stage`, { stage: "nope", return: "/deals" });
  assert.equal(bad.headers.get("location"), "/deals?saved=pick-stage");

  // Its page: details saved, the value as typed.
  const detail = await (await get(`/deals/${dealId}`)).text();
  assert.match(detail, /Lost reason/);
  assert.doesNotMatch(detail, /No task scheduled/, "a lost deal asks for nothing next");
  assert.match(detail, new RegExp(`For <a href="/customers/${pat.id}">Pat Doe</a>`));
  assert.match(detail, /Pat Doe/);
  assert.equal((await post(`/deals/${dealId}`, { title: "New boiler and flue", value: "5200", owner: "sam@team.example", expected_close: "2026-11-30", notes: "" })).headers.get("location"), `/deals/${dealId}?saved=deal-saved`);

  // New deal from the board, on a page of its own, for someone new: they are added as a lead.
  assert.match(await (await get("/deals/new")).text(), /<form method="post" action="\/deals"/);
  assert.equal((await post("/deals", { title: "Heat pump" })).headers.get("location"), "/deals/new?saved=name-needed");
  const fresh = await post("/deals", { name: "Rae Kim", email: "rae@example.com", title: "Heat pump", value: "" });
  assert.match(fresh.headers.get("location")!, /^\/deals\/\d+\?saved=deal-added$/);
  const [rae] = await db.sql<{ stage: string }>`select stage from customers where email = 'rae@example.com'`;
  assert.equal(rae.stage, "lead");
});

test("tasks: added, listed for today, the nav's count, done onto the timeline, moved; New task; no next step", async (t) => {
  if (skip) return t.skip(skip);
  const made = await post("/customers", { name: "Fay Lo", email: "fay@example.com", phone: "555 404 1212" });
  const id = made.headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  // No next step for a lead nobody has called: the Customers filter finds them.
  assert.match(await (await get("/customers?next=none")).text(), /Fay Lo/);

  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await post(`/customers/${id}/tasks`, { kind: "call", title: "", on: today })).headers.get("location"), `/customers/${id}?saved=task-needs`);
  assert.equal((await post(`/customers/${id}/tasks`, { kind: "call", title: "Call about the estimate", on: today, at: "09:30", owner: "ann@team.example" })).headers.get("location"), `/customers/${id}?saved=task-added`);
  assert.doesNotMatch(await (await get("/customers?next=none")).text(), /Fay Lo/, "planned now");

  const due = await (await get("/tasks?who=everyone")).text();
  assert.match(due, /Call about the estimate/);
  assert.match(due, /<h2[^>]*>Today<\/h2>[\s\S]*9:30 AM[\s\S]*Call about the estimate|<h2[^>]*>Today<\/h2>[\s\S]*Call about the estimate[\s\S]*9:30 AM/, "under Today, with its time");
  assert.match(due, /href="tel:5554041212"/, "a call shows the number");
  assert.match(await (await get("/tasks/count")).text(), /\d+<span class="sr-only"> due/);
  const customerPage = await (await get(`/customers/${id}`)).text();
  assert.ok(customerPage.indexOf(">Tasks</h2>") < customerPage.indexOf(">Activity</h2>"), "what happens next leads the page");
  assert.match(customerPage, /Call about the estimate/);

  const [f] = await db.sql<{ id: string }>`select id::text as id from follow_ups where customer_id = ${id}::bigint`;
  assert.equal((await post(`/tasks/${f.id}/move`, { on: "2099-01-02", return: "/tasks" })).headers.get("location"), "/tasks?saved=task-moved");
  const [moved] = await db.sql<{ due_on: string; due_time: string }>`select to_char(due_on, 'YYYY-MM-DD') as due_on, to_char(due_time, 'HH24:MI') as due_time from follow_ups where id = ${f.id}::bigint`;
  assert.deepEqual(moved, { due_on: "2099-01-02", due_time: "09:30" }, "a day button keeps the time");
  assert.match(await (await get("/tasks?who=everyone", { ...ME, "x-tasktool-user": "new@team.example" })).text(), /Call about the estimate/, "everyone's, however far off");
  assert.match(await (await get("/tasks", { ...ME, "x-tasktool-user": "ann@team.example" })).text(), /Call about the estimate/, "the viewer's own by default");
  assert.match(await (await get("/tasks", { ...ME, "x-tasktool-user": "new@team.example" })).text(), /Nothing on your list\./);

  const done = await post(`/tasks/${f.id}/done`, { outcome: "Booked the visit", return: "//evil.example" });
  assert.equal(done.headers.get("location"), `/customers/${id}?saved=task-done`);
  assert.equal((await post(`/tasks/${f.id}/done`, {})).headers.get("location"), `/customers/${id}?saved=task-already`);
  const [note] = await db.sql<{ kind: string; body: string }>`select kind, body from customer_notes where customer_id = ${id}::bigint`;
  assert.deepEqual(note, { kind: "call", body: "Call about the estimate\nBooked the visit" });
  assert.ok((await getCustomer(db, id))!.last_contact_at, "a call done is contact");
  assert.match(await (await get(`/customers/${id}`)).text(), /No task scheduled\./);
  assert.match(await (await get("/tasks?show=done")).text(), /Call about the estimate[\s\S]*Done /, "Done lists it, newest first");

  // Archived deals: off the board, a link away, as Pipedrive's archived deals are a filter away.
  await post(`/customers/${id}/deals`, { title: "Shelved deal" });
  const [shelved] = await db.sql<{ id: string }>`select id::text as id from deals where title = 'Shelved deal'`;
  await post(`/deals/${shelved.id}/archive`, { archived: "1" });
  assert.match(await (await get("/deals")).text(), /href="\/deals\/archived">\d+ archived</);
  assert.match(await (await get("/deals/archived")).text(), new RegExp(`href="/deals/${shelved.id}"[^>]*>Shelved deal<`));

  // A deal's page shows the invoices its quotes made, as HubSpot's deal does: was it paid?
  const dealNow = await post(`/customers/${id}/deals`, { title: "Invoiced deal", value: "100" });
  const dId = dealNow.headers.get("location")!.match(/\/deals\/(\d+)/)?.[1] ?? (await db.sql<{ id: string }>`select id::text as id from deals where title = 'Invoiced deal'`)[0].id;
  const [dq] = await db.sql<{ id: string }>`insert into quotes (number, email, currency, status, total_cents, subtotal_cents, deal_id) values ('Q-DEAL1', 'deal-inv@example.com', 'usd', 'accepted', 10000, 10000, ${dId}::bigint) returning id::text as id`;
  await db.sql`insert into invoices (email, currency, status, number, total_cents, quote_id) values ('deal-inv@example.com', 'usd', 'paid', 'INV-DEAL1', 10000, ${dq.id}::bigint)`;
  assert.match(await (await get(`/deals/${dId}`)).text(), /Quotes and invoices[\s\S]*Quote Q-DEAL1[\s\S]*Invoice INV-DEAL1/);

  // Ticked from the page (htmx): the task's done state comes back in its place, the sidebar told; Undo puts it back and takes its note away.
  await post(`/customers/${id}/tasks`, { kind: "call", title: "Tick me in place", on: today });
  const [tk] = await db.sql<{ id: string }>`select id::text as id from follow_ups where title = 'Tick me in place'`;
  const hxHeaders = { ...ME, origin: HOST, "hx-request": "true" };
  const ticked = await post(`/tasks/${tk.id}/done`, { return: "/tasks", show_customer: "1" }, hxHeaders);
  assert.equal(ticked.status, 200);
  assert.equal(ticked.headers.get("hx-trigger"), "tasks-changed");
  const tickedHtml = await ticked.text();
  assert.match(tickedHtml, new RegExp(`^<div id="task-${tk.id}" role="status"[\\s\\S]*line-through[\\s\\S]*Tick me in place[\\s\\S]*/tasks/${tk.id}/undo[\\s\\S]*>Undo<`));
  assert.match(tickedHtml, /href="\/customers\/\d+"/, "drawn as the list drew it: with whom");
  const notesFor = async () => (await db.sql`select 1 from customer_notes where customer_id = ${id}::bigint and body like 'Tick me in place%'`).length;
  assert.equal(await notesFor(), 1);
  const undone = await (await post(`/tasks/${tk.id}/undo`, { return: "/tasks", show_customer: "1" }, hxHeaders)).text();
  assert.match(undone, new RegExp(`^<div id="task-${tk.id}" class=[\\s\\S]*aria-label="Mark done: Call: Tick me in place"`));
  assert.equal(await notesFor(), 0, "its note is gone with the tick");
  assert.equal((await db.sql<{ done_at: Date | null }>`select done_at from follow_ups where id = ${tk.id}::bigint`)[0].done_at, null);
  assert.equal((await post(`/tasks/${tk.id}/undo`, { return: "/tasks" })).headers.get("location"), "/tasks?saved=task-already", "an open one has nothing to undo");
  await db.sql`delete from follow_ups where id = ${tk.id}::bigint`;

  // One ticked before ticks named their note: Undo finds the note written in the same instant, and their
  // last contact goes back to the latest that is left (an earlier call), not to nothing and not left at the tick.
  const [fresh] = await db.sql<{ id: string }>`insert into customers (name, email, stage) values ('Undo Person', 'undo.person@example.com', 'lead') returning id::text as id`;
  await post(`/customers/${fresh.id}/notes`, { kind: "call", body: "An earlier call", at: "2026-01-05T10:00" });
  await post(`/customers/${fresh.id}/tasks`, { kind: "call", title: "Ticked the old way", on: today });
  const [old] = await db.sql<{ id: string }>`select id::text as id from follow_ups where title = 'Ticked the old way'`;
  await post(`/tasks/${old.id}/done`, { return: "/tasks" });
  await db.sql`update follow_ups set done_note_id = null where id = ${old.id}::bigint`;
  const lastOf = async () => (await db.sql<{ at: string | null }>`select to_char(last_contact_at at time zone 'UTC', 'YYYY-MM-DD') as at from customers where id = ${fresh.id}::bigint`)[0].at;
  assert.equal(await lastOf(), new Date().toISOString().slice(0, 10), "the tick was their last contact");
  await post(`/tasks/${old.id}/undo`, { return: "/tasks" });
  assert.equal((await db.sql`select 1 from customer_notes where customer_id = ${fresh.id}::bigint and body = 'Ticked the old way'`).length, 0, "its note found and gone");
  assert.equal(await lastOf(), "2026-01-05", "back to the earlier call");
  await db.sql`delete from follow_ups where id = ${old.id}::bigint`;

  // New task from the Tasks page: for the customer picked, or for someone new.
  assert.match(await (await get("/tasks/new")).text(), /<option value="\d+">Fay Lo \(fay@example\.com\)<\/option>/, "the picker offers who is here");
  assert.equal((await post("/tasks", { name: "Fay Lo", title: "" , on: today })).headers.get("location"), "/tasks/new?saved=task-needs");
  assert.equal((await post("/tasks", { customer: id, title: "Send the brochure", kind: "email", on: today })).headers.get("location"), "/tasks?saved=task-added");
  assert.equal((await post("/tasks", { customer: "new", name: "Gus New", phone: "555 404 9999", title: "Call Gus", on: today })).headers.get("location"), "/tasks?saved=task-added");
  const added = await db.sql<{ title: string; email: string | null; name: string }>`
    select t.title, c.email::text as email, c.name from follow_ups t join customers c on c.id = t.customer_id where t.title in ('Send the brochure', 'Call Gus') order by t.title`;
  assert.deepEqual(added, [{ title: "Call Gus", email: null, name: "Gus New" }, { title: "Send the brochure", email: "fay@example.com", name: "Fay Lo" }]);
  // Picked from a page loaded before a merge: it goes to the record they were merged into.
  const [gus] = await db.sql<{ id: string }>`update customers set merged_into = ${id}::bigint, archived_at = now() where name = 'Gus New' returning id::text as id`;
  await post("/tasks", { customer: gus.id, title: "After the merge", on: today });
  const [merged] = await db.sql<{ customer_id: string }>`select customer_id::text as customer_id from follow_ups where title = 'After the merge'`;
  assert.equal(merged.customer_id, id);
  assert.match(await (await get("/tasks", { ...ME, "x-tasktool-user": "new@team.example" })).text(), /Nothing on your list\.[\s\S]*A task is a call[\s\S]*href="\/tasks\/new"[^>]*>New task<\/a>/, "someone with no tasks: the empty state offers New task");
});

test("nothing planned: a customer with an open deal is in play, a scheduled event is planned, one with nothing open is not", async (t) => {
  if (skip) return t.skip(skip);
  const made = await post("/customers", { name: "Nan Step", email: "nan@example.com" });
  const id = made.headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  const unplanned = async () => (await (await get("/customers?next=none")).text()).includes("Nan Step");
  assert.match(await (await get("/customers")).text(), new RegExp(`<tr id="customers-row-${id}"[^>]*data-href="/customers/${id}" onclick=`), "a click on the row opens them");
  await db.sql`update customers set stage = (select key from pipeline_stages where kind = 'won' order by position limit 1) where id = ${id}::bigint`;
  assert.equal(await unplanned(), false, "a customer with nothing open needs no next step");
  await post(`/customers/${id}/deals`, { title: "Second boiler", value: "" });
  assert.equal(await unplanned(), true, "an open deal with nothing planned");
  await post(`/customers/${id}/events`, { title: "Survey", at: "2099-03-01T10:00" });
  assert.equal(await unplanned(), false, "a scheduled event is planned");
});

test("Convert to deal opens the form filled in; saving it converts the lead, clears its request and gives the deal its call back", async (t) => {
  if (skip) return t.skip(skip);
  const sub = await insertSubmission(db, { form_key: "contact", name: "Gil Ross", email: "gil@example.com", phone: null, data: { message: "Need a quote for a new furnace" }, source: "website", page: null, status: "new" });
  const [gil] = await db.sql<{ id: string }>`select id::text as id from customers where email = 'gil@example.com'`;
  const [lead] = await db.sql<{ id: string }>`select id::text as id from leads where submission_id = ${sub}::bigint`;
  const form = await (await get(`/deals/new?from=lead.${lead.id}`)).text();
  assert.match(form, new RegExp(`<option value="${gil.id}" selected="">Gil Ross`), "their contact, chosen");
  assert.match(form, /name="title" required="" value="Gil Ross deal"/, "named for the person: the form's title says nothing about the work");
  assert.match(form, /<textarea name="notes"[^>]*>Need a quote for a new furnace<\/textarea>/, "what they wrote, as its notes");
  assert.match(form, new RegExp(`name="from" value="lead\\.${lead.id}"`));
  assert.match(form, new RegExp(`href="/leads/${lead.id}"[^>]*>← Lead`), "back goes to the lead");
  const first = await post("/deals", { from: `lead.${lead.id}`, customer: gil.id, title: "New furnace", value: "6500", notes: "Need a quote for a new furnace" });
  assert.match(first.headers.get("location")!, /^\/deals\/\d+\?saved=deal-added$/);
  const [made] = await db.sql<{ id: string; title: string; value_cents: string }>`select d.id::text as id, d.title, d.value_cents::text from deals d where d.customer_id = ${gil.id}::bigint`;
  assert.deepEqual([made.title, made.value_cents], ["New furnace", "650000"]);
  assert.deepEqual(await db.sql`select status, deal_id::text as deal_id from leads where id = ${lead.id}::bigint`, [{ status: "converted", deal_id: made.id }]);
  assert.equal((await db.sql<{ status: string }>`select status from submissions where id = ${sub}::bigint`)[0].status, "done", "the request is dealt with");

  // Their next request: their open deal is named, so a second one is a choice, not an accident.
  const sub2 = await insertSubmission(db, { form_key: "contact", name: "Gil Ross", email: "GIL@example.com", phone: null, data: { message: "And the garage" }, source: "website", page: null, status: "new" });
  const [lead2] = await db.sql<{ id: string }>`select id::text as id from leads where submission_id = ${sub2}::bigint`;
  assert.match(await (await get(`/deals/new?from=lead.${lead2.id}`)).text(), /Already open for Gil Ross:[\s\S]*>New furnace<\/a>/);
  await post("/deals", { from: `lead.${lead2.id}`, customer: gil.id, title: "Garage unit" });
  const calls = await db.sql<{ title: string; deal: string }>`
    select f.title, d.title as deal from follow_ups f join deals d on d.id = f.deal_id where f.customer_id = ${gil.id}::bigint order by f.id`;
  assert.deepEqual(calls, [{ title: "Call back Gil Ross", deal: "New furnace" }, { title: "Call back Gil Ross", deal: "Garage unit" }], "each deal its own first step");
  assert.equal((await get("/deals/new?from=submission.1")).status, 200, "an old Inbox link opens a blank form");
});

test("a deal's schedule: an event added from the deal is for it, shows it, and can be taken off it", async (t) => {
  if (skip) return t.skip(skip);
  const made = await post("/customers", { name: "Dee Lane", email: "dee@example.com", address: "7 Elm Row" });
  const cid = made.headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  const [deal] = await db.sql<{ id: string }>`insert into deals (customer_id, title, stage) values (${cid}::bigint, 'Heat pump', 'new') returning id::text as id`;
  const page = await (await get(`/deals/${deal.id}`)).text();
  assert.match(page, /<h2[^>]*>Schedule<\/h2>/);
  assert.match(page, new RegExp(`action="/customers/${cid}/events"[\\s\\S]*?<option value="${deal.id}" selected="">Heat pump</option>`), "the deal is chosen");
  assert.match(page, /name="location" value="7 Elm Row"/, "their address, as from their page");

  const added = await post(`/customers/${cid}/events`, { title: "Site visit", at: "2099-04-02T10:00", deal: deal.id });
  const eventId = added.headers.get("location")!.match(/\/events\/(\d+)/)![1];
  assert.match(await (await get(`/events/${eventId}`)).text(), new RegExp(`href="/deals/${deal.id}">Heat pump</a>`), "the event names its deal");
  assert.match(await (await get(`/deals/${deal.id}`)).text(), new RegExp(`href="/events/${eventId}"[^>]*>\\s*Site visit`), "the deal lists it");
  assert.match(await (await get("/events?q=Dee")).text(), /Site visit[\s\S]*?Heat pump/, "the list says which deal");

  await post(`/events/${eventId}`, { title: "Site visit", at: "2099-04-02T10:00", deal: "" });
  assert.equal((await db.sql<{ d: string | null }>`select deal_id::text as d from bookings where id = ${eventId}::bigint`)[0].d, null);
});

test("record pages: a deal has Activity and its contact; a contact's status is in Details; an invoice has one next step, More, and its balance", async (t) => {
  if (skip) return t.skip(skip);
  const made = await post("/customers", { name: "Rec Page", email: "recpage@example.com", phone: "555 321 0000" });
  const cid = made.headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  const [deal] = await db.sql<{ id: string }>`insert into deals (customer_id, title, stage) values (${cid}::bigint, 'Attic fan', 'new') returning id::text as id`;

  // A deal: write a note or log a call there, and reach the person without leaving it.
  let html = await (await get(`/deals/${deal.id}`)).text();
  assert.match(html, new RegExp(`action="/deals/${deal.id}/notes"`), "the deal's activity box");
  assert.match(html, /href="tel:[^"]*5553210000"/, "the contact card's phone");
  assert.equal((await post(`/deals/${deal.id}/notes`, { body: "Called about the fan", kind: "call" })).headers.get("location"), `/deals/${deal.id}?saved=note`);
  assert.match(await (await get(`/deals/${deal.id}`)).text(), /Called about the fan/);
  assert.match(await (await get(`/customers/${cid}`)).text(), /Called about the fan/, "it is on the contact's timeline too");

  // A contact: the status is a value under the name and changed in Details, not a control among the actions.
  html = await (await get(`/customers/${cid}`)).text();
  assert.match(html, /<h2[^>]*>Details<\/h2>[\s\S]*?name="status"/);
  assert.doesNotMatch(html.slice(0, html.indexOf("<h2")), /name="status"/, "no status select up with the actions");

  // An event that has started: Mark completed is the one blue button, the rest under More; its contact and Activity.
  const ev = await post(`/customers/${cid}/events`, { title: "Attic survey", at: "2020-03-02T10:00" });
  const eid = ev.headers.get("location")!.match(/\/events\/(\d+)/)![1];
  html = await (await get(`/events/${eid}`)).text();
  assert.match(html, /class="[^"]*bg-accent[^"]*">Mark completed</);
  assert.match(html, /<summary[^>]*>More<\/summary>[\s\S]*>No-show<[\s\S]*>Cancel</);
  assert.match(html, /<h2[^>]*>Contact<\/h2>[\s\S]*href="tel:/);
  assert.equal((await post(`/events/${eid}/notes`, { body: "Gate code 4411" })).headers.get("location"), `/events/${eid}?saved=note`);
  assert.match(await (await get(`/customers/${cid}`)).text(), /Gate code 4411/);

  // An invoice sent and owed: Record payment is the one blue button; the rest are under More; the balance is shown.
  const [inv] = await db.sql<{ id: string }>`
    insert into invoices (email, name, currency, status, livemode, total_cents, sent_at, number, hosted_url)
    values ('recpage@example.com', 'Rec Page', 'usd', 'open', true, 25000, now(), 'INV-REC1', 'https://pay.example/rec') returning id::text as id`;
  html = await (await get(`/invoices/${inv.id}`)).text();
  assert.match(html, new RegExp(`href="/invoices/${inv.id}/payment" class="[^"]*bg-accent[^"]*">Record payment<`));
  assert.match(html, /<summary[^>]*>More<\/summary>[\s\S]*>Payment page<[\s\S]*>Write off<[\s\S]*>Void</);
  assert.match(html, /Balance due<\/span><span[^>]*>\$250\.00</);
  await db.sql`delete from invoices where id = ${inv.id}::bigint`;
});

test("merge: preview, merge, history under either address, the merged record opens the kept one", async (t) => {
  if (skip) return t.skip(skip);
  const a = (await post("/customers", { name: "Hal Moe", email: "hal@example.com" })).headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  const b = (await post("/customers", { name: "Hal Moe", email: "hal.moe@work.example", phone: "555 777 0000" })).headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  await post(`/customers/${b}/notes`, { kind: "call", body: "Called from work" });
  await db.sql`insert into submissions (form_key, name, email, data, source) values ('contact', 'Hal', 'hal.moe@work.example', '{"message": "From the office"}', 'website')`;
  const page = await (await get(`/customers/${a}`)).text();
  assert.match(page, /Possible duplicates/);
  const preview = await (await get(`/customers/${a}/merge?other=${b}`)).text();
  assert.match(preview, /1 notes/);
  assert.match(preview, /phone/);
  assert.match(preview, /also goes by hal\.moe@work\.example/);
  assert.equal((await post(`/customers/${a}/merge`, { other: a })).headers.get("location"), `/customers/${a}/merge?saved=merge-same`);
  assert.equal((await post(`/customers/${a}/merge`, { other: b })).headers.get("location"), `/customers/${a}?saved=merged`);
  const kept = (await getCustomer(db, a))!;
  assert.deepEqual([kept.phone, kept.other_emails], ["555 777 0000", ["hal.moe@work.example"]]);
  const gone = (await getCustomer(db, b))!;
  assert.deepEqual([gone.email, gone.merged_into, !!gone.archived_at], [null, a, true]);
  assert.equal((await get(`/customers/${b}`)).headers.get("location"), `/customers/${a}`);
  const after = await (await get(`/customers/${a}`)).text();
  assert.match(after, /Called from work/);
  assert.match(after, /From the office/, "what came in under the other address");
  assert.match(after, /Also goes by/);
  // What comes in under the other address now matches the kept record.
  const again = await insertSubmission(db, { form_key: "contact", name: "Hal", email: "hal.moe@work.example", phone: null, data: {}, source: "website", page: null, status: "new" });
  assert.deepEqual(await db.sql`select customer_id::text as c from leads where submission_id = ${again}::bigint`, [{ c: a }]);
  assert.equal((await post(`/customers/${a}/merge`, { other: b })).headers.get("location"), `/customers/${a}/merge?saved=merge-gone`, "not twice");
});

test("a quote made for a deal: its value stands in, its page names the deal, and a yes wins it", async (t) => {
  if (skip) return t.skip(skip);
  const made = await post("/customers", { name: "Ida Quote", email: "ida@example.com" });
  const cid = made.headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  const deal = await post(`/customers/${cid}/deals`, { title: "Kitchen remodel", value: "" });
  const did = deal.headers.get("location")!.match(/\/deals\/(\d+)/)![1];
  const dealPage = await (await get(`/deals/${did}`)).text();
  const link = /href="(\/invoices\/quotes\/new\?[^"]+)"[^>]*>New quote</.exec(dealPage)![1].replace(/&amp;/g, "&");
  assert.match(link, new RegExp(`deal=${did}`));
  assert.match(await (await get(link)).text(), new RegExp(`name="deal_id" value="${did}"`));

  const body = new URLSearchParams({ email: "ida@example.com", name: "Ida Quote", currency: "usd", valid_until: "2099-01-31", visit_id: "", deal_id: did, notes: "", terms: "" });
  body.append("description", "Cabinets"); body.append("quantity", "1"); body.append("unit", "8000");
  const res = await app.request(HOST + "/invoices/quotes", { method: "POST", body, headers: { ...ME, origin: HOST, "content-type": "application/x-www-form-urlencoded" } }, { runtime });
  const qid = res.headers.get("location")!.match(/\/invoices\/quotes\/(\d+)/)![1];
  assert.match(await (await get(`/invoices/quotes/${qid}`)).text(), new RegExp(`<dd[^>]*><a href="/deals/${did}">Kitchen remodel</a><span[^>]*>A yes wins the deal\\.</span>`));
  const board = await (await get("/deals")).text();
  assert.match(board.split('<section data-stage="new"')[1].split("</section>")[0], /Kitchen remodel[\s\S]*\$8,000</, "the quote's total stands in for a blank value");

  await post(`/invoices/quotes/${qid}/decide`, { answer: "accepted" });
  const [d] = await db.sql<{ stage: string; closed: boolean }>`select stage, closed_at is not null as closed from deals where id = ${did}::bigint`;
  assert.deepEqual(d, { stage: "won", closed: true });
  assert.equal((await getCustomer(db, cid))!.stage, "customer");
  // A deal moved back by hand after the yes stays where it was put.
  await post(`/deals/${did}/stage`, { stage: "quoted" });
  const decline = new URLSearchParams(body);
  const r2 = await app.request(HOST + "/invoices/quotes", { method: "POST", body: decline, headers: { ...ME, origin: HOST, "content-type": "application/x-www-form-urlencoded" } }, { runtime });
  const q2 = r2.headers.get("location")!.match(/\/invoices\/quotes\/(\d+)/)![1];
  await post(`/invoices/quotes/${q2}/decide`, { answer: "declined" });
  const [still] = await db.sql<{ stage: string }>`select stage from deals where id = ${did}::bigint`;
  assert.equal(still.stage, "quoted");
  // The quote shows on the customer's timeline once it went out or was answered.
  assert.match(await (await get(`/customers/${cid}`)).text(), /Quote Q-\d{4}/);
});

test("stages page: both lists; add, refuse archiving one in use, archive with a move", async (t) => {
  if (skip) return t.skip(skip);
  const page = await (await get("/stages")).text();
  assert.match(page, /Deal stages/);
  assert.match(page, /Contact statuses/);
  assert.equal((await post("/stages/deals", { label: "Site visit", kind: "open" })).headers.get("location"), "/stages?saved=stage-added");
  assert.equal((await post("/stages/customers", { label: "Partner", kind: "won" })).headers.get("location"), "/stages?saved=stage-added");
  const [deal] = await db.sql<{ id: string }>`select id::text as id from deals order by id limit 1`;
  await post(`/deals/${deal.id}/stage`, { stage: "site-visit" });
  assert.equal((await post("/stages/deals/site-visit/archive", {})).headers.get("location"), "/stages?saved=stage-in-use");
  assert.equal((await post("/stages/deals/site-visit/archive", { move_to: "won" })).headers.get("location"), "/stages?saved=stage-archived");
  const [d] = await db.sql<{ stage: string }>`select stage from deals where id = ${deal.id}::bigint`;
  assert.equal(d.stage, "won");
  assert.equal((await post("/stages/deals/Bad Key/archive", {})).status, 404);
  assert.equal((await post("/stages/people/partner/archive", {})).status, 404);
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

test("events: add from the customer's page, the list, its page, status, CSV", async (t) => {
  if (skip) return t.skip(skip);
  const made = await post("/customers", { name: "Val Event", email: "val@example.com", phone: "555 404 0000", address: "12 Oak St" });
  const cid = made.headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  const [sam] = await db.sql<{ id: string }>`insert into resources (name, email, time_zone) values ('Sam', 'sam@team.example', 'UTC') returning id::text as id`;
  const page = await (await get(`/customers/${cid}`)).text();
  assert.match(page, /<h2[^>]*>Events<\/h2>/);
  assert.match(page, /<a href="\/schedule"[^>]*>(?:<svg.*?<\/svg>)?Schedule<\/a>/, "under Schedule in the nav");
  assert.match(page, /<form method="post" action="\/customers\/\d+\/events" aria-label="Add an event"/);
  assert.match(page, /name="location" value="12 Oak St"/, "a new one is at their address");
  assert.doesNotMatch(page, /Book a time|Create job/, "one way to put them on the schedule");
  const tabs = await (await get("/events")).text();
  assert.match(tabs, /<nav aria-label="Schedule"[\s\S]*>Calendar<[\s\S]*<a href="\/events" aria-current="page"[^>]*>Events<\/a>/, "the Schedule's tabs");
  assert.doesNotMatch(tabs, /<nav aria-label="Schedule"[^]*?<\/nav>[^]*>Services<\/a>[^]*<\/nav>/, "services and the team are Settings");

  assert.equal((await post(`/customers/${cid}/events`, { title: " ", at: "2099-01-15T09:30" })).headers.get("location"), `/customers/${cid}?saved=event-incomplete`);
  assert.equal((await post(`/customers/${cid}/events`, { title: "No time" })).headers.get("location"), `/customers/${cid}?saved=event-incomplete`);
  const added = await post(`/customers/${cid}/events`, { title: "Boiler service", at: "2099-01-15T09:30", minutes: "90", host: sam.id, location: "12 Oak St", amount: "$1,245.50" });
  const loc = added.headers.get("location")!;
  assert.match(loc, /^\/events\/\d+\?saved=event-added$/);
  const eid = loc.match(/\/events\/(\d+)/)![1];
  const detail = await (await get(loc)).text();
  assert.match(detail, /Event added\./);
  assert.match(detail, /value="2099-01-15T09:30"/, "the time back in the business's zone");
  assert.match(detail, /value="1245.50"/);
  assert.match(detail, /for 1 hr 30 min/);
  assert.match(detail, new RegExp(`<a href="/customers/${cid}"[^>]*>Val Event</a>`));
  assert.match(detail, />Scheduled</);
  assert.doesNotMatch(detail, /Mark completed/, "not before it starts");
  assert.equal((await get("/events/999999")).status, 404);
  assert.equal((await post(`/customers/999999/events`, { title: "x", at: "2099-01-15T09:30" })).status, 404);

  const list = await (await get("/events")).text();
  assert.match(list, /Boiler service/);
  assert.match(list, /\$1,245\.50/);
  assert.match(await (await get(`/events?host=${sam.id}`)).text(), /Boiler service/, "by the person taking it");
  assert.match(await (await get("/events?q=boiler", { ...ME, "hx-request": "true" })).text(), /^<div id="results">/);

  // A bad amount or time is flagged and keeps what was there; the rest saves.
  const saved = await post(`/events/${eid}`, { title: "Boiler service and flue check", at: "2099-02-30T09:30", minutes: "90", host: sam.id, location: "12 Oak St", amount: "lots" });
  assert.equal(saved.headers.get("location"), `/events/${eid}?saved=invalid`);
  const after = await (await get(`/events/${eid}`)).text();
  assert.match(after, /Boiler service and flue check/);
  assert.match(after, /value="2099-01-15T09:30"/);
  assert.match(after, /value="1245.50"/);

  // An edit from a form with no Service choice keeps the service an online booking came with.
  const [{ id: svc }] = await db.sql<{ id: string }>`insert into booking_types (slug, name) values (${`kept-${eid}`}, 'Kept service') returning id::text as id`;
  await db.sql`update bookings set type_id = ${svc}::bigint where id = ${eid}::bigint`;
  await post(`/events/${eid}`, { title: "Boiler service and flue check", at: "2099-01-15T09:30", minutes: "90", host: sam.id, location: "12 Oak St", amount: "1245.50" });
  assert.equal((await db.sql<{ t: string }>`select type_id::text as t from bookings where id = ${eid}::bigint`)[0].t, svc);
  await db.sql`update bookings set type_id = null where id = ${eid}::bigint`;

  // Completed through the booking pages' route, which comes back here; completed is contact and past.
  await db.sql`update bookings set starts_at = now() - interval '2 hours', ends_at = now() - interval '30 minutes' where id = ${eid}::bigint`;
  const over = await (await get(`/events/${eid}`)).text();
  assert.match(over, />Overdue</, "over and not marked");
  assert.match(over, /Mark completed/);
  const status = await post(`/schedule/${eid}/status`, { status: "completed" });
  assert.equal(status.headers.get("location"), `/events/${eid}?saved=status`);
  assert.ok((await getCustomer(db, cid))!.last_contact_at, "completed counts as contact");
  assert.doesNotMatch(await (await get("/events")).text(), /Boiler service/, "completed is not upcoming");
  assert.match(await (await get("/events?view=past")).text(), /Boiler service/);
  assert.match(await (await get(`/events/${eid}`)).text(), /href="\/invoices\/new\?[^"]*event=\d+[^"]*" class="[^"]*bg-accent[^"]*">New invoice</, "the invoice is its next step");

  const csv = await get("/events/export.csv?view=past&q=boiler");
  assert.equal(csv.status, 200);
  const text = new TextDecoder().decode(new Uint8Array(await csv.arrayBuffer()).slice(3));
  const lines = text.trim().split("\r\n");
  assert.equal(lines[0], `ID,Contact,Contact email,Contact phone,What,Service,When (${cfg.time_zone}),Status,Owner,Where,Amount (USD),Notes,Added (UTC)`);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /,Val Event,val@example\.com,555 404 0000,Boiler service and flue check,,\d{4}-\d{2}-\d{2} \d{2}:\d{2},Completed,Sam,12 Oak St,1245\.50,,/);

  assert.equal((await get("/events", { host: "crm.example" })).status, 404, "team only");
  assert.equal((await post(`/events/${eid}`, { title: "x", at: "2099-01-15T09:30" }, { ...ME, origin: "https://evil.example" })).status, 403);

  // New from the list: someone already here by email gets it; anyone else is added.
  assert.match(await (await get("/events/new")).text(), /<option value="\d+">Val Event \(val@example\.com\)<\/option>/);
  assert.equal((await post("/events", { title: "Tune-up", at: "2099-03-01T09:00", name: "" })).headers.get("location"), "/events/new?saved=name-needed");
  assert.equal((await post("/events", { title: "", name: "Val" })).headers.get("location"), "/events/new?saved=event-incomplete");
  const theirs = (await post("/events", { title: "Annual tune-up", at: "2099-03-01T09:00", email: "VAL@example.com" })).headers.get("location")!;
  assert.match(theirs, /^\/events\/\d+\?saved=event-added$/);
  const [same] = await db.sql<{ customer_id: string }>`select customer_id::text from bookings where id = ${theirs.match(/\/events\/(\d+)/)![1]}::bigint`;
  assert.equal(same.customer_id, cid, "matched by email, not added twice");
  const fresh = (await post("/events", { title: "Estimate", at: "2099-03-02T09:00", name: "Nia New", phone: "555 404 1111" })).headers.get("location")!;
  const [made2] = await db.sql<{ name: string; email: string | null }>`select c.name, b.email::text as email from bookings b join customers c on c.id = b.customer_id where b.id = ${fresh.match(/\/events\/(\d+)/)![1]}::bigint`;
  assert.deepEqual({ ...made2 }, { name: "Nia New", email: null }, "a customer with no email still has events");
});

test("the schedule in the CRM: its own frame, a service and a person; an online booking is an event, shown once", async (t) => {
  if (skip) return t.skip(skip);
  let html = await (await get("/services")).text();
  assert.match(html, /<nav aria-label="CRM"/, "the CRM's own frame");
  assert.match(html, /<a href="\/settings" aria-current="page"[^>]*>(?:<svg.*?<\/svg>)?Settings<\/a>/, "a setting, under Settings");
  assert.match(html, /<a href="\/settings"[^>]*>← Settings<\/a>/);
  assert.doesNotMatch(html, />Bookings</, "no second list of the same events");
  assert.equal((await get("/services", { host: "crm.example" })).status, 404, "team only");

  const person = await post("/team", { name: "Rae", email: "rae@team.example", time_zone: "America/Chicago", active: "1" });
  const personId = person.headers.get("location")!.match(/\/team\/(\d+)/)![1];
  const type = await post("/services", {
    name: "Estimate visit", slug: "estimate-visit", location_kind: "their_place", duration_min: "60", interval_min: "60",
    buffer_before_min: "30", buffer_after_min: "30", min_notice_min: "120", horizon_days: "30", active: "1",
  });
  const typeId = type.headers.get("location")!.match(/\/services\/(\d+)/)![1];
  assert.equal((await post(`/services/${typeId}/hosts`, { host: personId })).status, 303);

  // A booking the Website took is on the events list and the Calendar, and opens as an event.
  const [b] = await db.sql<{ id: string }>`
    insert into bookings (type_id, resource_id, starts_at, ends_at, name, email, location_kind, location, source)
    values (${typeId}::bigint, ${personId}::bigint, now() + interval '2 days', now() + interval '2 days 1 hour', 'Lee Wong', 'lee@example.com', 'their_place', '7 Pine St', 'website')
    returning id::text as id`;
  html = await (await get("/events")).text();
  assert.match(html, new RegExp(`href="/events/${b.id}"`));
  assert.match(html, /Estimate visit/);
  assert.doesNotMatch(html, /Bookings to convert|Create job/);
  html = await (await get(`/events/${b.id}`)).text();
  assert.match(html, /<h1[^>]*>Estimate visit<\/h1>/);
  assert.match(html, /Lee Wong/);
  assert.match(html, new RegExp(`href="/schedule/${b.id}/reschedule"`), "moved on the Schedule's Reschedule, which tells them");
  const [{ week }] = await db.sql<{ week: string }>`select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD') as week from bookings where id = ${b.id}::bigint`;
  await post("/events", { name: "Mo Job", email: "mo@example.com", title: "Fix the boiler", at: `${week}T15:00` });
  const cal = await (await get(`/schedule?date=${week}`)).text();
  assert.match(cal, new RegExp(`<a href="/events/${b.id}"[^>]*>Lee Wong</a><span class="text-ink-2"> · Estimate visit with Rae`), "the booking on the Calendar, opening its event");
  assert.match(cal, /Mo Job<\/a><span class="text-ink-2"> · Fix the boiler/, "one the team scheduled is there too");
  assert.match(cal, /href="\/events\/new"[^>]*>New event</);
  assert.doesNotMatch(cal, /New booking/);
  assert.match(cal, /Times are in UTC/, "the CRM's zone");
  // A cancel from its page goes through the booking pages and comes back.
  assert.equal((await post(`/schedule/${b.id}/status`, { status: "cancelled" })).headers.get("location"), `/events/${b.id}?saved=cancelled`);
});

test("quotes in the CRM: from an event, sent, accepted, invoiced", async (t) => {
  if (skip) return t.skip(skip);
  const made = await post("/customers", { name: "Quin Quote", email: "quin@example.com", phone: "555 777 0000" });
  const cid = made.headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  let html = await (await get(`/customers/${cid}`)).text();
  assert.match(html, /<a href="\/invoices"[^>]*>(?:<svg.*?<\/svg>)?Invoices<\/a>/, "in the nav");
  assert.match(html, /href="\/invoices\/quotes\/new\?email=quin%40example\.com&amp;name=Quin\+Quote/);

  // Quote from an event: what it is and its amount are the first line.
  const event = await post(`/customers/${cid}/events`, { title: "Water heater swap", at: "2099-04-01T09:00", amount: "1,200.00" });
  const vid = event.headers.get("location")!.match(/\/events\/(\d+)/)![1];
  html = await (await get(`/events/${vid}`)).text();
  const quoteLink = /href="(\/invoices\/quotes\/new\?[^"]+)"[^>]*>New quote</.exec(html)![1].replace(/&amp;/g, "&");
  html = await (await get(quoteLink)).text();
  assert.match(html, /<nav aria-label="CRM"/, "the CRM's own frame");
  assert.match(html, /<a href="\/invoices\/quotes" aria-current="page"[^>]*>(?:<svg.*?<\/svg>)?Quotes<\/a>/, "quotes are their own section");
  assert.match(html, /value="Water heater swap"/);
  assert.match(html, /value="1200\.00"/);
  assert.match(html, /Payment due within 30 days\./, "the config's standing terms");
  assert.match(html, new RegExp(`name="visit_id" value="${vid}"`));

  const body = new URLSearchParams({ email: "quin@example.com", name: "Quin Quote", currency: "usd", valid_until: "2099-01-31", visit_id: vid, notes: "", terms: "" });
  for (const [d, u] of [["Water heater swap", "1200.00"], ["", ""]]) {
    body.append("description", d); body.append("quantity", ""); body.append("unit", u);
  }
  const res = await app.request(HOST + "/invoices/quotes", { method: "POST", body, headers: { ...ME, origin: HOST, "content-type": "application/x-www-form-urlencoded" } }, { runtime });
  assert.equal(res.status, 303);
  const qid = res.headers.get("location")!.match(/\/invoices\/quotes\/(\d+)/)![1];
  html = await (await get(`/invoices/quotes/${qid}`)).text();
  assert.match(html, /\$1,200\.00/);
  // In Details: the customer once, as a link, then the event.
  assert.match(html, new RegExp(`<dd[^>]*><a href="/customers/${cid}">Quin Quote</a>`));
  assert.match(html, new RegExp(`<dt[^>]*>Event</dt><dd[^>]*><a href="/events/${vid}">`));
  assert.doesNotMatch(html, /<h2[^>]*>Customer<\/h2>/, "no card of its own");
  assert.doesNotMatch(html, /Create (job|event)/, "nothing to convert");

  // No sender connected here: nothing goes, and the page says to send it yourself.
  const send = await post(`/invoices/quotes/${qid}/send`, {});
  assert.match(decodeURIComponent(send.headers.get("location")!.replace(/\+/g, " ")), /Nothing was sent: no email sender is connected/);
  assert.equal((await getCustomer(db, cid))!.last_contact_at, null, "a quote nobody sent is not contact");
  assert.equal((await post(`/invoices/quotes/${qid}/sent`, {})).headers.get("location"), `/invoices/quotes/${qid}?saved=marked-sent`);
  assert.ok((await getCustomer(db, cid))!.last_contact_at, "a quote that went out is contact");
  assert.equal((await post(`/invoices/quotes/${qid}/decide`, { answer: "accepted" })).headers.get("location"), `/invoices/quotes/${qid}?saved=accepted`);

  // A completed event's Invoice carries its line; the quote's invoice comes from Make the invoice.
  await db.sql`update bookings set status = 'completed' where id = ${vid}::bigint`;
  html = await (await get(`/events/${vid}`)).text();
  assert.match(html, /href="\/invoices\/new\?[^"]*line=Water\+heater\+swap[^"]*"[^>]*>New invoice</);
  const inv = await post(`/invoices/quotes/${qid}/invoice`, {});
  const iid = inv.headers.get("location")!.match(/^\/invoices\/(\d+)\?saved=invoice-created$/)![1];
  html = await (await get(`/invoices/${iid}`)).text();
  assert.match(html, /<a href="\/invoices" aria-current="page"[^>]*>(?:<svg.*?<\/svg>)?Invoices<\/a>/, "the CRM's nav");
  // In Details: the customer once, as a link, then the event.
  assert.match(html, new RegExp(`<dd[^>]*><a href="/customers/${cid}">Quin Quote</a>`));
  assert.match(html, new RegExp(`<dt[^>]*>Event</dt><dd[^>]*><a href="/events/${vid}">`));
  assert.doesNotMatch(html, /<h2[^>]*>Customer<\/h2>/, "no card of its own");

  // What is quoted, owed and paid: on the customer's page and the event's, and paid by month on the list.
  html = await (await get(`/customers/${cid}`)).text();
  assert.match(html, /<h2[^>]*>Quotes and invoices<\/h2>/);
  assert.match(html, new RegExp(`<a href="/invoices/quotes/${qid}">Quote Q-\\d+</a>`));
  assert.match(html, new RegExp(`<a href="/invoices/${iid}">Draft invoice</a>`));
  assert.doesNotMatch(html, /Owes /, "a draft is not owed");
  await db.sql`update invoices set status = 'open', livemode = true, number = 'ACME-0042', due_date = '2099-01-31' where id = ${iid}::bigint`;
  html = await (await get(`/customers/${cid}`)).text();
  assert.match(html, /Owes \$1,200\.00 on an open invoice\./);
  assert.match(html, /Invoice ACME-0042<\/a>[\s\S]*?due <time[^>]*>Jan 31, 2099<\/time>/);
  assert.doesNotMatch(html, />Past due</, "not yet due");
  assert.match(html, /<h3[^>]*>[A-Z][a-z]+( \d{4})?<\/h3>/, "the timeline under month headings");
  await db.sql`update invoices set due_date = '2000-01-31' where id = ${iid}::bigint`;
  assert.match(await (await get(`/customers/${cid}`)).text(), /Invoice ACME-0042<\/a>[\s\S]*?>Past due</, "overdue, as the invoices page says it");
  await db.sql`update invoices set due_date = '2099-01-31' where id = ${iid}::bigint`;
  html = await (await get(`/events/${vid}`)).text();
  assert.match(html, /<h2[^>]*>Quote and invoice<\/h2>[\s\S]*Invoice ACME-0042/);
  html = await (await get("/invoices")).text();
  // Each figure is its label, then the amount, as Home's figures.
  assert.match(html, />Outstanding<\/span><span[^>]*>\$1,200</, "owed, on the invoices page");
  assert.match(html, />Paid this month<\/span><span[^>]*>\$0</, "nothing paid yet");
  await db.sql`update invoices set status = 'paid', paid_at = now() where id = ${iid}::bigint`;
  await db.sql`insert into payments (amount_cents, total_cents, currency, status, kind, ref_type, ref_id, livemode, paid_at)
    values (120000, 120000, 'usd', 'paid', 'invoice', 'invoice', ${iid}, true, now())`;
  html = await (await get("/invoices")).text();
  assert.match(html, />Paid this month<\/span><span[^>]*>\$1,200</);
  assert.match(html, />Outstanding<\/span><span[^>]*>\$0</);
  assert.doesNotMatch(await (await get(`/customers/${cid}`)).text(), /Owes /);

  assert.equal((await get(`/invoices/quotes/${qid}`, { host: "crm.example" })).status, 404, "team only");
  assert.equal((await get(`/invoices/${iid}`, { host: "crm.example" })).status, 404, "team only");
  assert.equal((await post(`/invoices/quotes/${qid}/decide`, { answer: "declined" }, { ...ME, origin: "https://evil.example" })).status, 403);
});

test("forms in the CRM: submissions by form, an order with its payment", async (t) => {
  if (skip) return t.skip(skip);
  const fields = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "email", label: "Email", type: "email", required: true },
    { name: "cookies", label: "Cookies", type: "items", currency: "usd", items: [{ key: "choc-chip", label: "Chocolate chip", unit: "dozen", price_cents: 4000 }] },
    { name: "pay", label: "Pay", type: "payment" },
  ];
  await db.sql`insert into forms (key, title, fields) values ('order', 'Cookie order', ${JSON.stringify(fields)}::jsonb) on conflict (key) do nothing`;
  const [order] = await db.sql<{ id: string }>`
    insert into submissions (form_key, name, email, data, source) values ('order', 'Olive Order', 'olive@example.com', '{"cookies": {"choc-chip": 2}}', 'website')
    returning id::text as id`;
  const [pay] = await db.sql<{ id: string }>`
    insert into payments (email, amount_cents, total_cents, currency, status, kind, ref_type, ref_id, livemode)
    values ('olive@example.com', 8000, 8660, 'usd', 'paid', 'full', 'submission', ${order.id}, true) returning id::text as id`;

  let html = await (await get("/forms/submissions?form=order")).text();
  assert.match(html, /<nav aria-label="CRM"/, "the CRM's own frame");
  assert.match(html, /<a href="\/settings" aria-current="page"[^>]*>(?:<svg.*?<\/svg>)?Settings<\/a>/);
  assert.match(html, /Olive Order/);
  assert.match(html, /Paid \$86\.60/);
  assert.doesNotMatch(html, /Pat Doe/, "only the order form's");

  html = await (await get(`/forms/submissions/${order.id}`)).text();
  assert.match(html, /2 x Chocolate chip, a dozen/);
  assert.match(html, new RegExp(`href="/invoices/payments/${pay.id}"`));
  assert.equal((await get(`/invoices/payments/${pay.id}`)).status, 200, "the payment, in the CRM");
  assert.equal((await get("/forms/unfinished")).status, 200);

  // A submission's booking is moved and cancelled on the Schedule's routes, and comes back to its event.
  const [bk] = await db.sql<{ id: string }>`
    insert into bookings (starts_at, ends_at, title, name, email, location_kind, submission_id, source)
    values (now() + interval '3 days', now() + interval '3 days 1 hour', 'Delivery', 'Olive Order', 'olive@example.com', 'their_place', ${order.id}::bigint, 'website')
    returning id::text as id`;
  html = await (await get(`/forms/submissions/${order.id}`)).text();
  assert.match(html, new RegExp(`href="/schedule/${bk.id}/reschedule"`));
  assert.match(await (await get(`/events/${bk.id}?saved=rescheduled`)).text(), /moved\. They have been told the new time\./, "a move from there says so on the event");
  const cancelled = await post(`/schedule/${bk.id}/status`, { status: "cancelled" });
  assert.equal(cancelled.headers.get("location"), `/events/${bk.id}?saved=cancelled`);

  assert.equal((await get("/forms/submissions", { host: "crm.example" })).status, 404, "team only");
});

// Review regressions.

test("a tampered paging cursor is the first page, not a server error", async (t) => {
  if (skip) return t.skip(skip);
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  for (const p of [`/customers?after=${enc(["2026-02-30 25:00", "1"])}`, `/customers?after=${enc(["yesterday", "1"])}`]) {
    assert.equal((await get(p)).status, 200, p);
  }
});

test("a return path that resolves to another site is not followed", async (t) => {
  if (skip) return t.skip(skip);
  for (const ret of ["/.//evil.example", "/a/..//evil.example/x"]) {
    const r = await post("/leads/999999/reopen", { return: ret });
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
  // The close runs just after the last chunk; wait for it, up to a second.
  for (let i = 0; !closed && i < 100; i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.ok(closed, "the pool is closed once the body is sent");
  await db.sql`delete from customers where email like 'bulk%@example.com'`;
});

test("a form or a service can make each lead a deal straight away, as Pipedrive's web forms and Jobber's job bookings do", async (t) => {
  if (skip) return t.skip(skip);
  // The form editor offers it, and saving it keeps it.
  await db.sql`insert into forms (key, title, fields, source) values ('install-request', 'Install request', ${JSON.stringify([{ name: "name", label: "Name", type: "text", required: true }, { name: "email", label: "Email", type: "email", required: true }, { name: "message", label: "Message", type: "textarea" }])}::jsonb, 'crm') on conflict do nothing`;
  let html = await (await get("/forms/form/install-request")).text();
  assert.match(html, /name="becomes" value="deal"/, "the CRM's form editor offers a deal straight away");
  // Its deals land in a stage it picks, owned by the person it names, as Pipedrive's web forms set both.
  const [second] = await db.sql<{ key: string }>`select key from deal_stages where kind = 'open' and not archived order by position offset 1 limit 1`;
  await db.sql`update forms set deals = true, owner = 'ann@team.example', deal_stage = ${second.key} where key = 'install-request'`;
  html = await (await get("/forms/form/install-request")).text();
  assert.match(html, /name="becomes" value="deal" checked=""/);
  assert.match(html, new RegExp(`name="deal_stage"[\\s\\S]*<option value="${second.key}" selected=""`), "Deals land in: the form's stage");
  assert.match(html, /name="owner"[^>]*value="ann@team.example"/, "Owner: the form's");

  // A submission, as the Website takes one: its lead is a deal by the next page.
  const sub = await insertSubmission(db, { form_key: "install-request", name: "Ivy Auto", email: "ivy.auto@example.com", phone: null, data: { message: "New AC for the shop" }, source: "website", page: null, status: "new" });
  await db.sql`update customers set company = 'Ivy Garage' where email = 'ivy.auto@example.com'`;
  await get("/");
  const [lead] = await db.sql<{ status: string; deal_id: string | null }>`select status, deal_id::text as deal_id from leads where submission_id = ${sub}::bigint`;
  assert.equal(lead.status, "converted");
  assert.ok(lead.deal_id, "with its deal");
  const [deal] = await db.sql<{ title: string; notes: string; stage: string; owner: string; created_by: string }>`select title, notes, stage, owner::text as owner, created_by::text as created_by from deals where id = ${lead.deal_id}::bigint`;
  assert.deepEqual({ ...deal }, { title: "Ivy Garage deal", notes: "New AC for the shop", stage: second.key, owner: "ann@team.example", created_by: "Website form" });
  assert.equal((await db.sql<{ owner: string }>`select owner::text as owner from leads where submission_id = ${sub}::bigint`)[0].owner, "ann@team.example", "the lead is the form's owner's too");
  assert.equal((await db.sql<{ status: string }>`select status from submissions where id = ${sub}::bigint`)[0].status, "done", "its submission done, as a convert does");
  assert.match(await (await get(`/deals/${lead.deal_id}`)).text(), /Where it came from[\s\S]*Converted/);
  assert.equal((await db.sql<{ owner: string }>`select owner::text as owner from follow_ups where deal_id = ${lead.deal_id}::bigint and title = 'Call back Ivy Auto'`)[0].owner, "ann@team.example", "and its call back, theirs");

  // A claim nobody finished (the process stopped between): taken up again once it is a few minutes old.
  const sub2 = await insertSubmission(db, { form_key: "install-request", name: "Una Stuck", email: "una.stuck@example.com", phone: null, data: { message: "Stuck" }, source: "website", page: null, status: "new" });
  await db.sql`update leads set status = 'converted', updated_at = now() - interval '10 minutes' where submission_id = ${sub2}::bigint`;
  await get("/");
  assert.ok((await db.sql<{ deal_id: string | null }>`select deal_id::text as deal_id from leads where submission_id = ${sub2}::bigint`)[0].deal_id, "its deal made after all");

  // A service that books deals: the booking's lead is a deal, its value the service's price.
  const [svc] = await db.sql<{ id: string }>`insert into booking_types (slug, name, duration_min, location_kind, location, price_cents, currency, deals) values ('auto-install', 'Install', 60, 'our_place', '1 Main St', 45000, 'usd', true) returning id::text as id`;
  assert.match(await (await get(`/services/${svc.id}`)).text(), /name="deals" value="1" checked=""/, "the service page offers it");
  const [c] = await db.sql<{ id: string }>`insert into customers (name, email, stage) values ('Bo Booker', 'bo.booker@example.com', 'lead') returning id::text as id`;
  const [host] = await db.sql<{ id: string }>`insert into resources (name, email, time_zone) values ('Hal Host', 'hal@team.example', 'UTC') returning id::text as id`;
  const [b] = await db.sql<{ id: string }>`insert into bookings (type_id, resource_id, starts_at, ends_at, name, email, status, customer_id, source, location_kind) values (${svc.id}::bigint, ${host.id}::bigint, now() + interval '2 days', now() + interval '2 days 1 hour', 'Bo Booker', 'bo.booker@example.com', 'confirmed', ${c.id}::bigint, 'website', 'our_place') returning id::text as id`;
  await db.sql`insert into leads (customer_id, source, booking_id, title) values (${c.id}::bigint, 'booking', ${b.id}::bigint, 'Install')`;
  // Two pages at once: one deal.
  await Promise.all([get("/deals"), get("/leads")]);
  const made = await db.sql<{ value_cents: string; title: string; currency: string; owner: string }>`select d.value_cents::text as value_cents, d.title, d.currency, d.owner::text as owner from deals d join leads l on l.deal_id = d.id where l.booking_id = ${b.id}::bigint`;
  assert.deepEqual(made.map((r) => ({ ...r })), [{ value_cents: "45000", title: "Bo Booker deal", currency: "USD", owner: "hal@team.example" }], "in the deals' own currency, as the board totals it");
  assert.equal((await db.sql`select 1 from deals where customer_id = ${c.id}::bigint`).length, 1, "made once");
  assert.equal((await db.sql<{ deal_id: string }>`select deal_id::text as deal_id from bookings where id = ${b.id}::bigint`)[0].deal_id !== null, true, "the booking is on the deal");
});

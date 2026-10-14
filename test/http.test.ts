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
  await applySchema(db, readFileSync("test/fixtures/other-apps.sql", "utf8"));
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

test("the Inbox: everyone in it is a customer already, then New deal and Done", async (t) => {
  if (skip) return t.skip(skip);
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  assert.match(html, /Contact us/);
  assert.match(html, /Do you service boilers\?/);
  assert.match(html, /href="\/deals\/new\?from=submission\.\d+"[^>]*>New deal<\/a>/, "New deal opens the form, filled in from the request");
  assert.match(html, />Done<\/button>/);
  assert.doesNotMatch(html, /Add as customer/);
  assert.doesNotMatch(html, /This project has no/, "every table is there");
  // To do by default, Everything a click away; the form filter applies on change with htmx, Apply without it.
  assert.match(html, /aria-current="page"[^>]*>To do</);
  assert.match(html, /href="\/\?view=all"/);
  assert.match(html, /<form method="get" action="\/" hx-get="\/" hx-target="#results" hx-swap="outerHTML" hx-push-url="true"/);
  assert.match(html, /<button[^>]*>Apply<\/button>/);
  const everything = await (await get("/?view=all", { ...ME, "hx-request": "true" })).text();
  assert.ok(everything.startsWith('<div id="results">'), "htmx gets the results block only");
  assert.match(everything, /Pat Doe/);
  assert.match(everything, /name="return" value="\/\?view=all"/, "Done comes back to the view");

  // The submission saved Pat as a customer as it came in: in the first open status, by no one.
  const [sub] = await db.sql<{ id: string }>`select id::text as id from submissions`;
  assert.match(html, new RegExp(`<li id="submission-${sub.id}" data-href="/forms/submissions/${sub.id}" onclick=`), "a click on the row opens the request");
  const [saved] = await db.sql<{ id: string }>`select id::text as id from customers where email = 'pat@example.com'`;
  const c = (await getCustomer(db, saved.id))!;
  assert.deepEqual([c.name, c.email, c.source, c.stage, c.created_by], ["Pat Doe", "pat@example.com", "Contact us", "lead", null]);
  assert.match(html, new RegExp(`href="/customers/${saved.id}"[^>]*>Pat Doe<`), "their name opens them");
  assert.equal((await db.sql`select 1 from follow_ups where customer_id = ${saved.id}::bigint`).length, 0, "saving them plans nothing: To do is the reminder");

  const done = await post("/inbox/done", { kind: "submission", id: sub.id, return: "//evil.example/x" });
  assert.equal(done.headers.get("location"), `/?saved=done&undo=submission.${sub.id}`, "a return path cannot leave the app; the message offers Undo");
  const [row] = await db.sql<{ status: string }>`select status from submissions where id = ${sub.id}::bigint`;
  assert.equal(row.status, "done");
  const after = await (await get(done.headers.get("location")!)).text();
  assert.doesNotMatch(after, /Do you service boilers\?/, "Done takes it off To do");
  assert.match(after, /Marked done\.[\s\S]*name="item" value="submission\.\d+"[\s\S]*>Undo<\/button>/);
  assert.equal((await post("/inbox/undo", { item: `submission.${sub.id}`, return: "/" })).headers.get("location"), "/?saved=undone");
  assert.match(await (await get("/")).text(), /Do you service boilers\?/, "Undo puts it back on To do");
  await post("/inbox/done", { kind: "submission", id: sub.id });
});

test("the Inbox shows a booker's own reschedule and a quote paid online, with Done only; a quote the team marked is not news", async (t) => {
  if (skip) return t.skip(skip);
  const [b] = await db.sql<{ id: string }>`
    insert into bookings (starts_at, ends_at, name, email, status, location_kind, source)
    values ('2099-05-01 15:00+00', '2099-05-01 16:00+00', 'Rae Fox', 'rae.fox@example.com', 'confirmed', 'our_place', 'website') returning id::text as id`;
  const [ch] = await db.sql<{ id: string }>`
    insert into booking_changes (booking_id, kind, was_starts_at, starts_at)
    values (${b.id}::bigint, 'rescheduled', '2099-04-30 15:00+00', '2099-05-01 15:00+00') returning id::text as id`;
  const [paid] = await db.sql<{ id: string }>`
    insert into quotes (number, email, name, status, currency, total_cents, decided_at, decided_by)
    values ('Q-9001', 'rae.fox@example.com', 'Rae Fox', 'accepted', 'usd', 238000, now(), 'paid online') returning id::text as id`;
  await db.sql`
    insert into quotes (number, email, name, status, currency, total_cents, decided_at, decided_by)
    values ('Q-9002', 'rae.fox@example.com', 'Rae Fox', 'accepted', 'usd', 5000, now(), 'ann@team.example')`;

  const html = await (await get("/")).text();
  const row = (kind: string, id: string) => html.match(new RegExp(`<li id="${kind}-${id}"[\\s\\S]*?</li>`))?.[0] ?? "";
  const moved = row("change", ch.id);
  assert.match(moved, /moved from/, "what they did, from when to when");
  assert.match(moved, new RegExp(`data-href="/events/${b.id}"`), "it opens the booking");
  assert.match(moved, />Done<\/button>/);
  assert.doesNotMatch(moved, /New deal/, "news about work in hand, not an enquiry");
  const yes = row("quote", paid.id);
  assert.match(yes, /Quote Q-9001/);
  assert.match(yes, /accepted and paid online/);
  assert.doesNotMatch(html, /Q-9002/, "the team's own mark is not news");

  for (const [kind, id] of [["change", ch.id], ["quote", paid.id]]) {
    assert.equal((await post("/inbox/done", { kind, id })).headers.get("location"), `/?saved=done&undo=${kind}.${id}`);
  }
  const after = await (await get("/")).text();
  assert.doesNotMatch(after, new RegExp(`id="change-${ch.id}"`));
  assert.doesNotMatch(after, new RegExp(`id="quote-${paid.id}"`));
  assert.match(await (await get("/?view=all")).text(), new RegExp(`id="quote-${paid.id}"`), "still in Everything");
});

test("leads: a form fill and a phone call; convert to a deal, add a second to it, archive with Undo", async (t) => {
  if (skip) return t.skip(skip);
  // A form fill, as the Website writes one: an open lead named for the form.
  const subId = await insertSubmission(db, { form_key: "contact", name: "Lou Park", email: "lou@example.com", phone: null, data: { message: "Need a new water heater" }, source: "website", page: null, status: "new" });
  const [formLead] = await db.sql<{ id: string }>`select id::text as id from leads where submission_id = ${subId}::bigint`;
  const list = await (await get("/leads")).text();
  assert.match(list, /Website form · Contact us/);
  assert.match(list, /Need a new water heater/);
  assert.match(list, new RegExp(`href="/deals/new\\?from=lead\\.${formLead.id}"[^>]*>Convert to deal<`));
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

  // Convert to deal: the New deal form, filled in from the lead; saving converts it and clears its request.
  const form = await (await get(`/deals/new?from=lead.${formLead.id}`)).text();
  assert.match(form, /name="title" required="" value="Contact us"/);
  assert.match(form, /<textarea name="notes"[^>]*>Need a new water heater<\/textarea>/);
  const [lou] = await db.sql<{ id: string }>`select id::text as id from customers where email = 'lou@example.com'`;
  const dealAt = (await post("/deals", { from: `lead.${formLead.id}`, customer: lou.id, title: "Water heater" })).headers.get("location")!;
  const dealId = dealAt.match(/\/deals\/(\d+)/)![1];
  assert.deepEqual(await db.sql`select status, deal_id::text as deal_id from leads where id = ${formLead.id}::bigint`, [{ status: "converted", deal_id: dealId }]);
  assert.equal((await db.sql<{ status: string }>`select status from submissions where id = ${subId}::bigint`)[0].status, "done", "its request is dealt with");
  assert.match(await (await get(`/deals/${dealId}`)).text(), /Where it came from[\s\S]*Website form · Contact us/);

  // Lou asks again while the deal is open: Add to deal, not a second deal.
  const again = await insertSubmission(db, { form_key: "contact", name: "Lou Park", email: "lou@example.com", phone: null, data: { message: "And the softener" }, source: "website", page: null, status: "new" });
  const [second] = await db.sql<{ id: string }>`select id::text as id from leads where submission_id = ${again}::bigint`;
  const lead2 = await (await get(`/leads/${second.id}`)).text();
  assert.match(lead2, />Add to deal</);
  assert.doesNotMatch(lead2, />Convert to deal</);
  assert.equal((await post(`/leads/${second.id}/attach`, { deal: dealId })).headers.get("location"), `/deals/${dealId}?saved=lead-attached`);
  assert.equal((await db.sql`select 1 from deals where customer_id = ${lou.id}::bigint`).length, 1, "still one deal");
  assert.match(await (await get(`/customers/${lou.id}`)).text(), /<h2[^>]*>Leads<\/h2>[\s\S]*Converted[\s\S]*Converted/, "their page lists both leads");
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
  assert.equal(plain.headers.get("location"), "/deals?saved=deal-stage");
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

  const due = await (await get("/tasks")).text();
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
  assert.match(await (await get("/tasks", { ...ME, "x-tasktool-user": "new@team.example" })).text(), /Call about the estimate/, "everyone's by default, however far off");
  assert.match(await (await get("/tasks?who=mine", { ...ME, "x-tasktool-user": "new@team.example" })).text(), /Nothing on your list\./);

  const done = await post(`/tasks/${f.id}/done`, { outcome: "Booked the visit", return: "//evil.example" });
  assert.equal(done.headers.get("location"), `/customers/${id}?saved=task-done`);
  assert.equal((await post(`/tasks/${f.id}/done`, {})).headers.get("location"), `/customers/${id}?saved=task-already`);
  const [note] = await db.sql<{ kind: string; body: string }>`select kind, body from customer_notes where customer_id = ${id}::bigint`;
  assert.deepEqual(note, { kind: "call", body: "Call about the estimate\nBooked the visit" });
  assert.ok((await getCustomer(db, id))!.last_contact_at, "a call done is contact");
  assert.match(await (await get(`/customers/${id}`)).text(), /No task scheduled\./);

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
  assert.match(await (await get("/tasks?who=mine", { ...ME, "x-tasktool-user": "new@team.example" })).text(), /Nothing on your list\.[\s\S]*A task is a call[\s\S]*href="\/tasks\/new"[^>]*>New task<\/a>/, "someone with no tasks: the empty state offers New task");
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

test("New deal from the Inbox opens the form filled in; saving it clears the request and gives the deal its call back", async (t) => {
  if (skip) return t.skip(skip);
  // Someone not saved yet (written straight into the table): the form offers Someone new, filled in.
  const [sub] = await db.sql<{ id: string }>`
    insert into submissions (form_key, name, email, phone, data, source)
    values ('contact', 'Gil Ross', 'gil@example.com', null, '{"message": "Need a quote for a new furnace"}', 'website') returning id::text as id`;
  const form = await (await get(`/deals/new?from=submission.${sub.id}`)).text();
  assert.match(form, /<option value="new" selected="">Someone new<\/option>/);
  assert.match(form, /name="name" value="Gil Ross"/);
  assert.match(form, /name="title" required="" value="Contact us"/, "named for what they asked");
  assert.match(form, /<textarea name="notes"[^>]*>Need a quote for a new furnace<\/textarea>/, "what they wrote, as its notes");
  assert.match(form, new RegExp(`name="from" value="submission\\.${sub.id}"`));
  const first = await post("/deals", { from: `submission.${sub.id}`, customer: "new", name: "Gil Ross", email: "gil@example.com", title: "New furnace", value: "6500", notes: "Need a quote for a new furnace" });
  assert.match(first.headers.get("location")!, /^\/deals\/\d+\?saved=deal-added$/);
  const [made] = await db.sql<{ title: string; value_cents: string; notes: string }>`select d.title, d.value_cents::text, d.notes from deals d join customers c on c.id = d.customer_id where c.email = 'gil@example.com'`;
  assert.deepEqual(made, { title: "New furnace", value_cents: "650000", notes: "Need a quote for a new furnace" });
  assert.equal((await db.sql<{ status: string }>`select status from submissions where id = ${sub.id}::bigint`)[0].status, "done", "the request is dealt with");

  // Their next request, as the Website writes it (so they are already a customer): chosen for you, with their open deal named.
  const sub2 = await insertSubmission(db, { form_key: "contact", name: "Gil Ross", email: "GIL@example.com", phone: null, data: { message: "And the garage" }, source: "website", page: null, status: "new" });
  const [gil] = await db.sql<{ id: string }>`select id::text as id from customers where email = 'gil@example.com'`;
  const again = await (await get(`/deals/new?from=submission.${sub2}`)).text();
  assert.match(again, new RegExp(`<option value="${gil.id}" selected="">Gil Ross`));
  assert.match(again, /Already open for Gil Ross:[\s\S]*>New furnace<\/a>/, "a second deal is a choice, not an accident");
  await post("/deals", { from: `submission.${sub2}`, customer: gil.id, title: "Garage unit" });
  const calls = await db.sql<{ title: string; deal: string }>`
    select f.title, d.title as deal from follow_ups f join deals d on d.id = f.deal_id where f.customer_id = ${gil.id}::bigint order by f.id`;
  assert.deepEqual(calls, [{ title: "Call back Gil Ross", deal: "New furnace" }, { title: "Call back Gil Ross", deal: "Garage unit" }], "each deal its own first step");
  assert.match(await (await get("/?view=all")).text(), /New deal<\/a>/, "a customer's new enquiry can still be a deal");
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
  const inbox = await (await get("/?view=all")).text();
  assert.match(inbox, new RegExp(`/customers/${a}"[^>]*>\\s*Hal Moe`));
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
  assert.match(await (await get("/events")).text(), /<nav aria-label="Schedule"[\s\S]*>Calendar<[\s\S]*<a href="\/events" aria-current="page"[^>]*>Events<\/a>[\s\S]*>Services<[\s\S]*>Team</, "the Schedule's tabs");

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
  assert.match(await (await get(`/events/${eid}`)).text(), /href="\/invoices\/new\?[^"]*event=\d+[^"]*" class="[^"]*bg-accent[^"]*">Invoice</, "the invoice is its next step");

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
  assert.match(html, /<a href="\/schedule" aria-current="page"[^>]*>(?:<svg.*?<\/svg>)?Schedule<\/a>/);
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
  const cal = await (await get(`/schedule?week=${week}`)).text();
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
  const quoteLink = /href="(\/invoices\/quotes\/new\?[^"]+)"[^>]*>Quote</.exec(html)![1].replace(/&amp;/g, "&");
  html = await (await get(quoteLink)).text();
  assert.match(html, /<nav aria-label="CRM"/, "the CRM's own frame");
  assert.match(html, /<nav aria-label="Quotes and invoices"/);
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
  assert.match(html, /href="\/invoices\/new\?[^"]*line=Water\+heater\+swap[^"]*"[^>]*>Invoice</);
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
  assert.match(html, /\$1,200<\/span><span[^>]*>Outstanding</, "owed, on the invoices page");
  assert.match(html, /\$0<\/span><span[^>]*>Paid this month</, "nothing paid yet");
  await db.sql`update invoices set status = 'paid', paid_at = now() where id = ${iid}::bigint`;
  html = await (await get("/invoices")).text();
  assert.match(html, /\$1,200<\/span><span[^>]*>Paid this month</);
  assert.match(html, /\$0<\/span><span[^>]*>Outstanding</);
  assert.doesNotMatch(await (await get(`/customers/${cid}`)).text(), /Owes /);

  assert.equal((await get(`/invoices/quotes/${qid}`, { host: "crm.example" })).status, 404, "team only");
  assert.equal((await get(`/invoices/${iid}`, { host: "crm.example" })).status, 404, "team only");
  assert.equal((await post(`/invoices/quotes/${qid}/decide`, { answer: "declined" }, { ...ME, origin: "https://evil.example" })).status, 403);
});

test("forms in the CRM: submissions by form, an order with its payment, the Inbox by form", async (t) => {
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
  assert.match(html, /<a href="\/forms" aria-current="page"[^>]*>(?:<svg.*?<\/svg>)?Forms<\/a>/);
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

  html = await (await get("/?form=order")).text();
  assert.match(html, /Olive Order/);
  assert.doesNotMatch(html, /Pat Doe/);
  assert.match(html, /<option value="order" selected="">Cookie order<\/option>/);
  assert.match(await (await get("/?view=all")).text(), /Pat Doe/, "everything, unfiltered");

  assert.equal((await get("/forms/submissions", { host: "crm.example" })).status, 404, "team only");
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
  // The close runs just after the last chunk; wait for it, up to a second.
  for (let i = 0; !closed && i < 100; i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.ok(closed, "the pool is closed once the body is sent");
  await db.sql`delete from customers where email like 'bulk%@example.com'`;
});

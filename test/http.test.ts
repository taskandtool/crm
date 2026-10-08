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
  for (const p of ["/", "/customers", "/customers/1", "/customers/export.csv", "/deals", "/deals/1", "/follow-ups", "/follow-ups/count", "/stages", "/nope"]) {
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
  assert.deepEqual([c.name, c.email, c.source, c.stage, c.created_by], ["Pat Doe", "pat@example.com", "Contact us", "lead", "ann@team.example"]);
  // A new lead gets a call back today, for whoever added them.
  const [call] = await db.sql<{ title: string; owner: string; today: boolean }>`select title, owner::text as owner, due_on = (now() at time zone 'UTC')::date as today from follow_ups where customer_id = ${id}::bigint`;
  assert.deepEqual(call, { title: "Call back Pat Doe", owner: "ann@team.example", today: true });
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

test("deals: the board's columns and totals; a move answers htmx with the board and a plain post with a 303; winning makes them a customer", async (t) => {
  if (skip) return t.skip(skip);
  const [pat] = await db.sql<{ id: string }>`select id::text as id from customers where email = 'pat@example.com'`;
  await db.sql`update customers set stage = 'lead' where id = ${pat.id}::bigint`;
  const made = await post(`/customers/${pat.id}/deals`, { title: "New boiler", value: "4,500", stage: "contacted" });
  assert.match(made.headers.get("location")!, /^\/deals\/\d+\?saved=deal-added$/);
  const dealId = made.headers.get("location")!.match(/\/deals\/(\d+)/)![1];
  assert.match((await post(`/customers/${pat.id}/deals`, { title: "", value: "1" })).headers.get("location")!, /saved=deal-title-needed/);

  const page = await (await get("/deals")).text();
  for (const label of ["New", "Contacted", "Quote sent", "Won", "Lost"]) assert.match(page, new RegExp(`<section data-stage="[a-z]+" aria-label="${label}, \\d+"`));
  assert.match(page, /Sortable\.min\.js/);
  const contacted = page.split('<section data-stage="contacted"')[1].split("</section>")[0];
  assert.match(contacted, /New boiler/);
  assert.match(contacted, /\$4,500\.00/, "the column's total");
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
  assert.equal((await getCustomer(db, pat.id))!.stage, "customer", "losing a later deal does not undo who they are");
  const bad = await post(`/deals/${dealId}/stage`, { stage: "nope", return: "/deals" });
  assert.equal(bad.headers.get("location"), "/deals?saved=pick-stage");

  // Its page: details saved, the value as typed; a won deal becomes a job once.
  const detail = await (await get(`/deals/${dealId}`)).text();
  assert.match(detail, /Why it was lost/);
  assert.match(detail, /Pat Doe/);
  assert.equal((await post(`/deals/${dealId}`, { title: "New boiler and flue", value: "5200", owner: "sam@team.example", expected_close: "2026-11-30", notes: "" })).headers.get("location"), `/deals/${dealId}?saved=deal-saved`);
  await post(`/deals/${dealId}/stage`, { stage: "won" });
  const job = await post(`/deals/${dealId}/job`, {});
  assert.match(job.headers.get("location")!, /^\/visits\/\d+\?saved=visit-added$/);
  const again = await post(`/deals/${dealId}/job`, {});
  assert.equal(again.headers.get("location"), job.headers.get("location"), "once per deal");
  const [v] = await db.sql<{ title: string; amount_cents: string }>`select title, amount_cents::text from customer_visits where deal_id = ${dealId}::bigint`;
  assert.deepEqual(v, { title: "New boiler and flue", amount_cents: "520000" });

  // New deal from the board for someone new: they are added as a lead.
  const fresh = await post("/deals", { name: "Rae Kim", email: "rae@example.com", title: "Heat pump", value: "" });
  assert.match(fresh.headers.get("location")!, /^\/deals\/\d+\?saved=deal-added$/);
  const [rae] = await db.sql<{ stage: string }>`select stage from customers where email = 'rae@example.com'`;
  assert.equal(rae.stage, "lead");
});

test("follow-ups: added, listed as due, the nav's count, done onto the timeline, moved; nothing planned", async (t) => {
  if (skip) return t.skip(skip);
  const made = await post("/customers", { name: "Fay Lo", email: "fay@example.com", phone: "555 404 1212" });
  const id = made.headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  // Nothing planned for a lead nobody has called.
  assert.match(await (await get("/follow-ups?view=none&who=all")).text(), /Fay Lo/);

  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await post(`/customers/${id}/follow-ups`, { kind: "call", title: "", on: today })).headers.get("location"), `/customers/${id}?saved=fu-needs`);
  assert.equal((await post(`/customers/${id}/follow-ups`, { kind: "call", title: "Call about the estimate", on: today, at: "09:30", owner: "ann@team.example" })).headers.get("location"), `/customers/${id}?saved=fu-added`);
  assert.doesNotMatch(await (await get("/follow-ups?view=none&who=all")).text(), /Fay Lo/, "planned now");

  const due = await (await get("/follow-ups")).text();
  assert.match(due, /Call about the estimate/);
  assert.match(due, /Today 9:30 AM/);
  assert.match(due, /href="tel:5554041212"/, "a call shows the number");
  assert.match(await (await get("/follow-ups/count")).text(), /\d+<span class="sr-only"> due/);
  const customerPage = await (await get(`/customers/${id}`)).text();
  assert.ok(customerPage.indexOf(">Follow-ups</h2>") < customerPage.indexOf(">Details</h2>"), "what happens next leads the page");
  assert.match(customerPage, /Call about the estimate/);

  const [f] = await db.sql<{ id: string }>`select id::text as id from follow_ups where customer_id = ${id}::bigint`;
  assert.equal((await post(`/follow-ups/${f.id}/move`, { on: "2099-01-02", return: "/follow-ups" })).headers.get("location"), "/follow-ups?saved=fu-moved");
  const [moved] = await db.sql<{ due_on: string; due_time: string }>`select to_char(due_on, 'YYYY-MM-DD') as due_on, to_char(due_time, 'HH24:MI') as due_time from follow_ups where id = ${f.id}::bigint`;
  assert.deepEqual(moved, { due_on: "2099-01-02", due_time: "09:30" }, "a day button keeps the time");
  assert.match(await (await get("/follow-ups?view=upcoming")).text(), /Nothing in the next 14 days/);

  const done = await post(`/follow-ups/${f.id}/done`, { outcome: "Booked the visit", return: "//evil.example" });
  assert.equal(done.headers.get("location"), `/customers/${id}?saved=fu-done`);
  assert.equal((await post(`/follow-ups/${f.id}/done`, {})).headers.get("location"), `/customers/${id}?saved=fu-already`);
  const [note] = await db.sql<{ kind: string; body: string }>`select kind, body from customer_notes where customer_id = ${id}::bigint`;
  assert.deepEqual(note, { kind: "call", body: "Call about the estimate\nBooked the visit" });
  assert.ok((await getCustomer(db, id))!.last_contact_at, "a call done is contact");
  assert.match(await (await get(`/customers/${id}`)).text(), /Nothing planned\. What happens next\?/);
});

test("Add as deal: a new person, and a customer already here getting another", async (t) => {
  if (skip) return t.skip(skip);
  const [sub] = await db.sql<{ id: string }>`
    insert into submissions (form_key, name, email, phone, data, source)
    values ('contact', 'Gil Ross', 'gil@example.com', null, '{"message": "Need a quote"}', 'website') returning id::text as id`;
  const first = await post("/inbox/deal", { kind: "submission", id: sub.id });
  assert.match(first.headers.get("location")!, /^\/deals\/\d+\?saved=deal-added$/);
  const [sub2] = await db.sql<{ id: string }>`
    insert into submissions (form_key, name, email, data, source)
    values ('contact', 'Gil Ross', 'GIL@example.com', '{"message": "And the garage"}', 'website') returning id::text as id`;
  await post("/inbox/deal", { kind: "submission", id: sub2.id });
  const deals = await db.sql<{ title: string }>`select d.title from deals d join customers c on c.id = d.customer_id where c.email = 'gil@example.com' order by d.id`;
  assert.deepEqual(deals.map((d) => d.title), ["Gil Ross, Contact us", "Gil Ross, Contact us"], "one person, two deals");
  const calls = await db.sql<{ n: number }>`select count(*)::int as n from follow_ups f join customers c on c.id = f.customer_id where c.email = 'gil@example.com'`;
  assert.equal(calls[0].n, 1, "one open call back is enough");
  assert.match(await (await get("/")).text(), /Add as deal/);
});

test("merge: preview, merge, history under either address, the merged record opens the kept one", async (t) => {
  if (skip) return t.skip(skip);
  const a = (await post("/customers", { name: "Hal Moe", email: "hal@example.com" })).headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  const b = (await post("/customers", { name: "Hal Moe", email: "hal.moe@work.example", phone: "555 777 0000" })).headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  await post(`/customers/${b}/notes`, { kind: "call", body: "Called from work" });
  await db.sql`insert into submissions (form_key, name, email, data, source) values ('contact', 'Hal', 'hal.moe@work.example', '{"message": "From the office"}', 'website')`;
  const page = await (await get(`/customers/${a}`)).text();
  assert.match(page, /Maybe the same person/);
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
  const inbox = await (await get("/")).text();
  assert.match(inbox, new RegExp(`/customers/${a}"[^>]*>\\s*Open Hal Moe`));
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
  body.append("description", "Cabinets"); body.append("quantity", "1"); body.append("unit", "8000"); body.append("tax_rate_id", "");
  const res = await app.request(HOST + "/invoices/quotes", { method: "POST", body, headers: { ...ME, origin: HOST, "content-type": "application/x-www-form-urlencoded" } }, { runtime });
  const qid = res.headers.get("location")!.match(/\/invoices\/quotes\/(\d+)/)![1];
  assert.match(await (await get(`/invoices/quotes/${qid}`)).text(), new RegExp(`For <a href="/deals/${did}">Kitchen remodel</a>; a yes wins the deal`));
  const board = await (await get("/deals")).text();
  assert.match(board.split('<section data-stage="new"')[1].split("</section>")[0], /Kitchen remodel[\s\S]*\$8,000\.00/, "the quote's total stands in for a blank value");

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
  assert.match(page, /Customer statuses/);
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
  const bookLink = /href="(\/bookings\/new\?[^"]+)"[^>]*>Book a time</.exec(html)![1].replace(/&amp;/g, "&");
  assert.match(bookLink, /name=Lee\+Wong&email=lee%40example\.com/);
  html = await (await get(bookLink)).text();
  assert.match(html, /<h1[^>]*>Book a time for Lee Wong<\/h1>/);
  assert.match(html, /Estimate visit/);
  html = await (await get("/bookings/schedule")).text();
  assert.match(html, /<a href="\/bookings" aria-current="page"[^>]*>Bookings<\/a>/, "inside the CRM's frame");
  assert.match(html, /Times are in UTC\./, "the CRM's zone");
});

test("quotes in the CRM: from a job, sent, accepted, made a job; Make it a job once", async (t) => {
  if (skip) return t.skip(skip);
  const made = await post("/customers", { name: "Quin Quote", email: "quin@example.com", phone: "555 777 0000" });
  const cid = made.headers.get("location")!.match(/\/customers\/(\d+)/)![1];
  let html = await (await get(`/customers/${cid}`)).text();
  assert.match(html, /<a href="\/invoices"[^>]*>Invoices<\/a>/, "in the nav");
  assert.match(html, /href="\/invoices\/quotes\/new\?email=quin%40example\.com&amp;name=Quin\+Quote/);

  // Quote this job: the job's title and amount are the first line.
  const job = await post(`/customers/${cid}/visits`, { title: "Water heater swap", status: "planned", amount: "1,200.00" });
  const vid = job.headers.get("location")!.match(/\/visits\/(\d+)/)![1];
  html = await (await get(`/visits/${vid}`)).text();
  const quoteLink = /href="(\/invoices\/quotes\/new\?[^"]+)">Quote this visit</.exec(html)![1].replace(/&amp;/g, "&");
  html = await (await get(quoteLink)).text();
  assert.match(html, /<nav aria-label="CRM"/, "the CRM's own frame");
  assert.match(html, /<nav aria-label="Quotes and invoices"/);
  assert.match(html, /value="Water heater swap"/);
  assert.match(html, /value="1200\.00"/);
  assert.match(html, /Payment due within 30 days\./, "the config's standing terms");
  assert.match(html, new RegExp(`name="visit_id" value="${vid}"`));

  const body = new URLSearchParams({ email: "quin@example.com", name: "Quin Quote", currency: "usd", valid_until: "2099-01-31", visit_id: vid, notes: "", terms: "" });
  for (const [d, u] of [["Water heater swap", "1200.00"], ["", ""]]) {
    body.append("description", d); body.append("quantity", ""); body.append("unit", u); body.append("tax_rate_id", "");
  }
  const res = await app.request(HOST + "/invoices/quotes", { method: "POST", body, headers: { ...ME, origin: HOST, "content-type": "application/x-www-form-urlencoded" } }, { runtime });
  assert.equal(res.status, 303);
  const qid = res.headers.get("location")!.match(/\/invoices\/quotes\/(\d+)/)![1];
  html = await (await get(`/invoices/quotes/${qid}`)).text();
  assert.match(html, /\$1,200\.00/);
  assert.match(html, new RegExp(`<a href="/customers/${cid}">Quin Quote</a>`));
  assert.match(html, new RegExp(`<a href="/visits/${vid}">The visit</a>`));

  // No sender connected here: nothing goes, and the page says to send it yourself.
  const send = await post(`/invoices/quotes/${qid}/send`, {});
  assert.match(decodeURIComponent(send.headers.get("location")!.replace(/\+/g, " ")), /Nothing was sent: no email sender is connected/);
  assert.equal((await getCustomer(db, cid))!.last_contact_at, null, "a quote nobody sent is not contact");
  assert.equal((await post(`/invoices/quotes/${qid}/sent`, {})).headers.get("location"), `/invoices/quotes/${qid}?saved=marked-sent`);
  assert.ok((await getCustomer(db, cid))!.last_contact_at, "a quote that went out is contact");
  assert.equal((await post(`/invoices/quotes/${qid}/decide`, { answer: "accepted" })).headers.get("location"), `/invoices/quotes/${qid}?saved=accepted`);

  // A quote for someone new, accepted with no job: Make it a job adds them, once.
  const nb = new URLSearchParams({ email: "new@example.com", name: "Nia New", currency: "usd", valid_until: "", visit_id: "", notes: "", terms: "", address: "9 Elm St" });
  nb.append("description", "Gutter clean"); nb.append("quantity", "1"); nb.append("unit", "180"); nb.append("tax_rate_id", "");
  const r2 = await app.request(HOST + "/invoices/quotes", { method: "POST", body: nb, headers: { ...ME, origin: HOST, "content-type": "application/x-www-form-urlencoded" } }, { runtime });
  const q2 = r2.headers.get("location")!.match(/\/invoices\/quotes\/(\d+)/)![1];
  assert.equal((await post(`/invoices/quotes/${q2}/job`, {})).headers.get("location"), `/invoices/quotes/${q2}?saved=not-now`, "only an accepted quote");
  await post(`/invoices/quotes/${q2}/decide`, { answer: "accepted" });
  assert.match(await (await get(`/invoices/quotes/${q2}`)).text(), /Not a customer yet\.[\s\S]*Make it a visit/);
  const [one, two] = await Promise.all([post(`/invoices/quotes/${q2}/job`, {}), post(`/invoices/quotes/${q2}/job`, {})]);
  assert.equal(one.headers.get("location"), two.headers.get("location"));
  const jobUrl = one.headers.get("location")!;
  assert.match(jobUrl, /^\/visits\/\d+\?saved=visit-added$/);
  html = await (await get(jobUrl)).text();
  assert.match(html, /<h1[^>]*>Gutter clean<\/h1>/);
  assert.match(html, />Nia New<\/a>/);
  assert.match(html, /value="180\.00"/);
  const [{ n }] = await db.sql<{ n: number }>`select count(*)::int as n from customer_visits where title = 'Gutter clean'`;
  assert.equal(n, 1);
  const [nia] = await db.sql<{ address: string; source: string }>`select address, source from customers where email = 'new@example.com'`;
  assert.deepEqual({ ...nia }, { address: "9 Elm St", source: "Quote" });

  // Invoice this job: the job's line on a new invoice; the quote's invoice from Make the invoice.
  html = await (await get(`/visits/${vid}`)).text();
  assert.match(html, /href="\/invoices\/new\?[^"]*line=Water\+heater\+swap[^"]*">Invoice this visit</);
  const inv = await post(`/invoices/quotes/${qid}/invoice`, {});
  const iid = inv.headers.get("location")!.match(/^\/invoices\/(\d+)\?saved=invoice-created$/)![1];
  html = await (await get(`/invoices/${iid}`)).text();
  assert.match(html, /<a href="\/invoices" aria-current="page"[^>]*>Invoices<\/a>/, "the CRM's nav");
  assert.match(html, new RegExp(`<a href="/customers/${cid}">Quin Quote</a>`));
  assert.match(html, new RegExp(`<a href="/visits/${vid}">The visit</a>`));

  // What is quoted, owed and paid: on the customer's page and the job's, and paid by month on the list.
  html = await (await get(`/customers/${cid}`)).text();
  assert.match(html, /<h2[^>]*>Quotes and invoices<\/h2>/);
  assert.match(html, new RegExp(`<a href="/invoices/quotes/${qid}">Quote Q-\\d+</a>`));
  assert.match(html, new RegExp(`<a href="/invoices/${iid}">Draft invoice</a>`));
  assert.doesNotMatch(html, /Owes /, "a draft is not owed");
  await db.sql`update invoices set status = 'open', livemode = true, number = 'ACME-0042', due_date = '2099-01-31' where id = ${iid}::bigint`;
  html = await (await get(`/customers/${cid}`)).text();
  assert.match(html, /Owes \$1,200\.00 on an open invoice\./);
  assert.match(html, /Invoice ACME-0042<\/a>[\s\S]*?due January 31, 2099/);
  html = await (await get(`/visits/${vid}`)).text();
  assert.match(html, /<h2[^>]*>Quote and invoice<\/h2>[\s\S]*Invoice ACME-0042/);
  assert.doesNotMatch(await (await get("/invoices")).text(), /Paid by month/, "nothing paid yet");
  await db.sql`update invoices set status = 'paid', paid_at = now() where id = ${iid}::bigint`;
  html = await (await get("/invoices")).text();
  assert.match(html, /Paid by month[\s\S]*\$1,200\.00/);
  assert.doesNotMatch(await (await get(`/customers/${cid}`)).text(), /Owes /);

  assert.equal((await get(`/invoices/quotes/${qid}`, { host: "crm.example" })).status, 404, "team only");
  assert.equal((await get(`/invoices/${iid}`, { host: "crm.example" })).status, 404, "team only");
  assert.equal((await post(`/invoices/quotes/${qid}/decide`, { answer: "declined" }, { ...ME, origin: "https://evil.example" })).status, 403);
});

test("forms in the CRM: submissions by form, an order with its payment, What came in by form", async (t) => {
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
  assert.match(html, /<a href="\/forms\/submissions" aria-current="page"[^>]*>Forms<\/a>/);
  assert.match(html, /Olive Order/);
  assert.match(html, /Paid \$86\.60/);
  assert.doesNotMatch(html, /Pat Doe/, "only the order form's");

  html = await (await get(`/forms/submissions/${order.id}`)).text();
  assert.match(html, /2 x Chocolate chip, a dozen/);
  assert.match(html, new RegExp(`href="/invoices/payments/${pay.id}"`));
  assert.equal((await get(`/invoices/payments/${pay.id}`)).status, 200, "the payment, in the CRM");
  assert.equal((await get("/forms/submissions/unfinished")).status, 200);

  html = await (await get("/?form=order")).text();
  assert.match(html, /Olive Order/);
  assert.doesNotMatch(html, /Pat Doe/);
  assert.match(html, /<option value="order" selected="">Cookie order<\/option>/);
  assert.match(await (await get("/")).text(), /Pat Doe/, "everything, unfiltered");

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
  await new Promise((ok) => setTimeout(ok, 50));
  assert.ok(closed, "the pool is closed once the body is sent");
  await db.sql`delete from customers where email like 'bulk%@example.com'`;
});

// Proposals over HTTP, as the team and the customer use them: a quote's
// components, its page, the link given by hand and by email, the
// customer opening it signed out, a page changed under them, the signature
// and what it does (deal won, the attached deposit sent), a decline, mail scanners, a
// dead link. Skipped without TEST_DATABASE_URL.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../src/app";
import { cfg, seeds } from "../src/config";
import { todayIn } from "../src/invoices/document";
import type { Db } from "../src/data/db";
import { setup } from "../src/db/setup";
import { saveBusiness } from "../src/data/business";
import { invoiceById, invoicesFor } from "../src/invoices/invoices";
import { quoteById } from "../src/invoices/quotes";
import { markEmailed } from "../src/proposals/store";
import { chooseFaces, END, latinFaces, missingWeights, rewrite, rolesFor, START } from "../scripts/proposal-font.mjs";
import { wordsOf } from "../scripts/proposal-copy";
import type { Runtime } from "../src/runtime";
import { scratch, type Scratch } from "./scratch";

const HOST = "https://crm.example";
const ME = { "x-tasktool-user": "pat@team.example", host: "crm.example" };
const NOBODY = { host: "crm.example" };

let s: Scratch | null = null;
let skip: string | false = false;
let db: Db;
let runtime: Runtime;
const realFetch = globalThis.fetch;
const mail: { to: string[]; subject: string; text: string }[] = [];

before(async () => {
  delete process.env.ADMIN_DEV_USER;
  const r = await scratch("proposals");
  if (typeof r === "string") {
    skip = r;
    return;
  }
  s = r;
  db = r.db;
  await setup(db, seeds);
  await saveBusiness(db, { name: "Acme Test Co" }, "ann@team.example");
  runtime = { open: () => ({ db }) };
  // Production is this app (its /q/ answers as proposals do); the owner's sender is Resend, faked.
  process.env.PROPOSAL_BASE_URL = HOST;
  process.env.RESEND_API_KEY = "re_test";
  process.env.NOTIFY_FROM = "Acme <hello@acme.example>";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(HOST)) return app.request(url, { ...init, headers: NOBODY }, { runtime });
    if (url.startsWith("https://api.resend.com")) {
      mail.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  for (const k of ["PROPOSAL_BASE_URL", "RESEND_API_KEY", "NOTIFY_FROM"]) delete process.env[k];
  await s?.drop();
});

const get = (path: string, headers: Record<string, string> = ME) => app.request(HOST + path, { headers }, { runtime });
const post = (path: string, form: Record<string, string | string[]> | FormData, headers: Record<string, string> = ME) => {
  const body = form instanceof FormData ? form : new URLSearchParams();
  if (!(form instanceof FormData)) for (const [k, v] of Object.entries(form)) for (const x of Array.isArray(v) ? v : [v]) (body as URLSearchParams).append(k, x);
  return app.request(HOST + path, { method: "POST", body, headers: { ...headers, origin: HOST } }, { runtime });
};
const tokenOf = (html: string) => /value="https:\/\/crm\.example\/q\/([A-Za-z0-9_-]{43})"/.exec(html)![1];
const shaOf = (html: string) => /name="page" value="([0-9a-f]{64})"/.exec(html)![1];

async function customerWithDeal(name: string, email: string) {
  const [c] = await db.sql`insert into customers (name, email, stage) values (${name}, ${email}, 'lead') returning id::text as id`;
  const [d] = await db.sql`insert into deals (customer_id, title, stage) values (${c.id}::bigint, ${"Fence for " + name}, 'quoted') returning id::text as id`;
  return { customer: c.id as string, deal: d.id as string };
}

async function newQuote(email: string, name: string, deal: string, unit = "2000.00") {
  const res = await post("/invoices/quotes", {
    email, name, currency: "usd", valid_until: "2099-12-31", deal_id: deal, visit_id: "", notes: "", terms: "",
    description: ["Cedar fence", ""], quantity: ["", ""], unit: [unit, ""], tax: "",
  });
  assert.equal(res.status, 303, await res.text());
  return /\/invoices\/quotes\/(\d+)\?saved=created/.exec(res.headers.get("location")!)![1];
}

test("a proposal end to end: built, its deposit attached, linked, opened, changed under them, signed; its deal won and its deposit sent", async (t) => {
  if (skip) return t.skip(skip);
  const { deal } = await customerWithDeal("Ann Lee", "ann@example.com");
  const id = await newQuote("ann@example.com", "Ann Lee", deal);

  // The quote's page: the components by name, with check marks; one not registered is refused.
  let html = await (await get(`/invoices/quotes/${id}`)).text();
  assert.match(html, /name="components" value="about"/);
  assert.match(html, /About us<\/span><span class="text-ink-3"> \(sample\)/, "a component still showing the starter's words says so");
  assert.match(html, /Read our website and write our proposal sections from it\./, "and what to ask the AI");
  let res = await post(`/invoices/quotes/${id}/proposal`, { title: "A new fence", components: ["about", "nope"] });
  assert.match(decodeURIComponent(res.headers.get("location")!), /Nothing was saved: No component nope/);

  res = await post(`/invoices/quotes/${id}/proposal`, { title: "A new fence for Ann", components: ["about", "reviews"] });
  assert.match(res.headers.get("location")!, /saved=saved$/);
  assert.deepEqual((await db.sql`select key from quote_components where quote_id = ${id}::bigint order by key`).map((r) => r.key), ["about", "reviews"]);

  // Their yes sends what the owner attaches: New invoice from the quote's page starts from its lines; this one is a deposit.
  html = await (await get(`/invoices/new?quote=${id}`)).text();
  assert.match(html, /New invoice for quote Q-\d{4}/);
  assert.match(html, /value="Cedar fence"/, "the quote's lines to start from");
  assert.match(html, /href="\/invoices\/recurring\/new\?quote=\d+"[^>]*>Repeats/, "or one that repeats");
  res = await post("/invoices", {
    email: "ann@example.com", name: "Ann Lee", currency: "usd", quote_id: id, days_until_due: "14", notes: "", visit_id: "",
    description: ["Deposit", ""], quantity: ["", ""], unit: ["1000.00", ""], tax: "",
  });
  assert.match(res.headers.get("location")!, new RegExp(`/invoices/quotes/${id}\\?saved=invoice-attached$`));
  html = await (await get(`/invoices/quotes/${id}`)).text();
  assert.match(html, /When they say yes/);
  assert.match(html, /Draft invoice<\/a><span class="text-ink-2">\$1,000\.00/);

  const doc = await (await get(`/invoices/quotes/${id}/document`)).text();
  assert.match(doc, /A new fence for Ann/);
  assert.match(doc, /id="about"/);
  assert.match(doc, /id="reviews"/);
  assert.doesNotMatch(doc, /id="team"/, "a component not ticked is not on the page");
  assert.match(doc, /id="pricing"/, "pricing is on every one");
  assert.match(doc, /When you sign, the invoice for \$1,000\.00 is due, and you are taken straight to pay it online\./);
  assert.match(doc, /The team or the work/, "a photograph's slot says what belongs there");
  assert.match(doc, /A preview: on the customer(&#39;|')s page this form signs it/);
  assert.doesNotMatch(doc, /<script/);

  // Before it goes: what still shows sample words.
  html = await (await get(`/invoices/quotes/${id}/send`)).text();
  assert.match(html, /About us, Reviews still show sample words/);

  // Copy link: shown once, the quote sent.
  html = await (await get(`/invoices/quotes/${id}/send`)).text();
  assert.match(html, /Copy link/);
  res = await post(`/invoices/quotes/${id}/send`, { how: "link" });
  const token = tokenOf(await res.text());
  assert.equal((await quoteById(db, id))!.status, "sent");

  // The customer, signed out: the page, its headers, an open counted.
  res = await get(`/q/${token}`, NOBODY);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-proposals"), "1");
  assert.match(res.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.equal(res.headers.get("referrer-policy"), "same-origin");
  assert.equal(res.headers.get("cache-control"), "no-store, no-transform");
  html = await res.text();
  assert.match(html, /Type your full name/);
  assert.match(html, /Review and accept the quote/, "the bar to Accept");
  assert.ok((await quoteById(db, id))!.viewed_at, "Viewed");
  await get(`/q/${token}`, ME);
  assert.deepEqual((await db.sql`select who from quote_views where quote_id = ${id}::bigint order by id`).map((r) => r.who), ["customer", "team"]);

  // A change the team makes while they read: the same link shows the new page, and the old one cannot be signed.
  const oldSha = shaOf(html);
  res = await post(`/invoices/quotes/${id}`, {
    email: "ann@example.com", name: "Ann Lee", currency: "usd", valid_until: "2099-12-31", deal_id: deal, visit_id: "", notes: "", terms: "",
    description: ["Cedar fence", "Gate", ""], quantity: ["", "", ""], unit: ["2000.00", "400.00", ""], tax: "",
  });
  assert.equal(res.status, 303);
  res = await post(`/q/${token}`, { name: "Ann Lee", agree: "1", page: oldSha }, NOBODY);
  assert.equal(res.status, 409);
  html = await res.text();
  assert.match(html, /was updated since you opened it/);
  assert.match(html, /\$2,400\.00/, "they see the new total");
  assert.equal((await quoteById(db, id))!.status, "sent");

  // Another site cannot sign for them; a missing name or box is said.
  assert.equal((await app.request(HOST + `/q/${token}`, { method: "POST", body: new URLSearchParams({ name: "X", agree: "1", page: shaOf(html) }), headers: { ...NOBODY, origin: "https://evil.example" } }, { runtime })).status, 403);
  res = await post(`/q/${token}`, { name: "Ann Lee", page: shaOf(html) }, NOBODY);
  assert.equal(res.status, 422);
  assert.match(await res.text(), /Tick the box/);

  // An edit the stored page missed (its re-make failed, or raced the signature): signing it is stale, and the page is made again.
  await db.sql`update quotes set total_cents = 240100, updated_at = now() where id = ${id}::bigint`;
  res = await post(`/q/${token}`, { name: "Ann Lee", agree: "1", page: shaOf(html) }, NOBODY);
  assert.equal(res.status, 409);
  html = await res.text();
  assert.match(html, /\$2,401\.00/, "they see the quote as it stands");
  await db.sql`update quotes set total_cents = 240000, updated_at = now() where id = ${id}::bigint`;
  html = await (await get(`/q/${token}`, NOBODY)).text();
  assert.match(html, /\$2,400\.00/, "opening it shows the quote as it stands too");

  res = await post(`/q/${token}`, { name: "Ann Lee", agree: "1", page: shaOf(html) }, NOBODY);
  assert.equal(res.status, 303);
  const qt = (await quoteById(db, id))!;
  assert.deepEqual([qt.status, qt.decided_by], ["accepted", "signed online"]);
  const [sig] = await db.sql`select name, email::text as email, page_html, page_sha256 from quote_signatures where quote_id = ${id}::bigint`;
  assert.deepEqual([sig.name, sig.email], ["Ann Lee", "ann@example.com"]);
  assert.match(sig.page_html, /Signed on/);
  assert.match(sig.page_sha256, /^[0-9a-f]{64}$/);
  assert.equal((await db.sql`select stage from deals where id = ${deal}::bigint`)[0].stage, "won");
  const invoices = await invoicesFor(db, { quoteId: id });
  assert.equal(invoices.length, 1);
  const dep = (await invoiceById(db, invoices[0].id))!;
  assert.deepEqual([dep.lines[0].description, dep.total_cents], ["Deposit", "100000"], "the owner's own deposit, not a share of the new total");
  // No Stripe here: it stays a draft, and a task says so.
  assert.equal(dep.status, "draft");
  assert.match((await db.sql`select title from follow_ups where title like 'The invoice for $1,000.00%'`)[0]?.title ?? "", /Stripe is not connected/);
  assert.match(mail.at(-1)!.subject, /^You signed quote Q-\d{4} with Acme Test Co$/);
  assert.match(mail.at(-1)!.text, new RegExp(`Your copy, with what happens next: ${HOST}/q/${token}`));

  // The link is now their copy; the quote no longer changes.
  html = await (await get(`/q/${token}`, NOBODY)).text();
  assert.match(html, /Signed on/);
  assert.match(html, /Coming by email/);
  assert.doesNotMatch(html, /Type your full name/);
  res = await post(`/invoices/quotes/${id}/proposal`, { title: "Changed", components: ["team"] });
  assert.match(decodeURIComponent(res.headers.get("location")!), /Nothing was saved: It was accepted/);
  assert.deepEqual((await db.sql`select key from quote_components where quote_id = ${id}::bigint order by key`).map((r) => r.key), ["about", "reviews"]);
});

test("then, recurring: a weekly plan waits on the proposal, shown beside the total; signing starts it, makes today's and makes the lead a customer; a no ends another and discards its deposit", async (t) => {
  if (skip) return t.skip(skip);
  // A lead with no deal: the yes alone makes them a customer.
  const [eve] = await db.sql`insert into customers (name, email, stage) values ('Eve Park', 'eve@example.com', 'lead') returning id::text as id`;
  const deal = "";
  const id = await newQuote("eve@example.com", "Eve Park", deal, "500.00");
  let html = await (await get(`/invoices/quotes/${id}`)).text();
  assert.match(html, new RegExp(`href="/invoices/new\\?quote=${id}"`), "New invoice, on the quote");
  assert.match(await (await get(`/invoices/new?quote=${id}`)).text(), new RegExp(`href="/invoices/recurring/new\\?quote=${id}"[^>]*>Repeats`), "whose Repeats makes a recurring one");
  assert.match(await (await get(`/invoices/recurring/new?quote=${id}`)).text(), /value="eve@example\.com"/, "the form starts from the quote's customer");

  // Weekly from today, so any day of the month will do; a draft for the team, so no Stripe here.
  const today = todayIn(cfg.time_zone);
  let res = await post("/invoices/recurring", {
    quote_id: id, email: "eve@example.com", name: "Eve Park", currency: "usd", title: "Weekly lawn care", period: "week", every: "1", first_on: today,
    ends: "never", mode: "draft", days_ahead: "0", days_until_due: "14", description: ["Mowing", ""], quantity: ["", ""], unit: ["60", ""], tax: "",
  });
  assert.match(res.headers.get("location")!, new RegExp(`/invoices/quotes/${id}\\?saved=recurring-pending$`));
  const [rec] = await db.sql`select id::text as id, status from recurring_invoices where quote_id = ${id}::bigint`;
  assert.equal(rec.status, "pending");
  html = await (await get(`/invoices/quotes/${id}`)).text();
  assert.match(html, /When they say yes[\s\S]*>Weekly lawn care<\/a><span class="block text-label text-ink-2">\$60\.00 every week/);

  const token = tokenOf(await (await post(`/invoices/quotes/${id}/send`, { how: "link" })).text());
  html = await (await get(`/q/${token}`, NOBODY)).text();
  assert.match(html, /\$60\.00 every week on \w+, invoiced to you\./, "the customer reads it beside the total");
  assert.match(html, /\$500\.00/, "and the total stays the one-off amount");
  res = await post(`/q/${token}`, { name: "Eve Park", agree: "1", page: shaOf(html) }, NOBODY);
  assert.equal(res.status, 303);

  const [after] = await db.sql`select status, made, to_char(next_on, 'YYYY-MM-DD') as next_on from recurring_invoices where id = ${rec.id}::bigint`;
  assert.deepEqual([after.status, after.made], ["active", 1]);
  assert.equal((await db.sql`select stage from customers where id = ${eve.id}::bigint`)[0].stage, "customer");
  assert.equal(after.next_on, new Date(Date.parse(today + "T00:00:00Z") + 7 * 86_400_000).toISOString().slice(0, 10));
  const [inv] = await db.sql`select status, quote_id, to_char(period_on, 'YYYY-MM-DD') as period_on from invoices where recurring_id = ${rec.id}::bigint`;
  assert.deepEqual([inv.status, inv.quote_id, inv.period_on], ["draft", null, today], "today's is made at once, and not listed on the proposal");
  const [task] = await db.sql`select title from follow_ups where title like 'Review Eve Park%'`;
  assert.match(task.title, /^Review Eve Park's invoice for the week of/);

  // A second proposal with its own plan, declined at the link: the plan never starts.
  const other = await newQuote("eve@example.com", "Eve Park", deal, "100.00");
  await post("/invoices/recurring", {
    quote_id: other, email: "eve@example.com", currency: "usd", title: "Monthly care", period: "month", every: "1", first_on: "2099-01-01",
    ends: "never", mode: "send", description: ["Care", ""], quantity: ["", ""], unit: ["40", ""], tax: "",
  });
  await post("/invoices", { email: "eve@example.com", currency: "usd", quote_id: other, days_until_due: "14", description: ["Deposit", ""], quantity: ["", ""], unit: ["50", ""], tax: "" });
  const t2 = tokenOf(await (await post(`/invoices/quotes/${other}/send`, { how: "link" })).text());
  const page2 = await (await get(`/q/${t2}`, NOBODY)).text();
  await post(`/q/${t2}/decline`, { reason: "Price", note: "", page: shaOf(page2) }, NOBODY);
  assert.equal((await db.sql`select status from recurring_invoices where quote_id = ${other}::bigint`)[0].status, "ended");
  assert.deepEqual((await db.sql`select status from invoices where quote_id = ${other}::bigint`).map((r) => r.status), ["void"], "its deposit is discarded");
});

test("emailed: the link goes by the owner's sender with nothing attached; an open in the first minute is a mail scanner", async (t) => {
  if (skip) return t.skip(skip);
  const { deal } = await customerWithDeal("Bo Ray", "bo@example.com");
  const id = await newQuote("bo@example.com", "Bo Ray", deal);
  const before = mail.length;
  const res = await post(`/invoices/quotes/${id}/send`, { how: "email" });
  assert.match(res.headers.get("location")!, /saved=sent-link$/);
  const m = mail[before];
  assert.deepEqual(m.to, ["bo@example.com"]);
  const token = /\/q\/([A-Za-z0-9_-]{43})/.exec(m.text)![1];
  assert.equal((m as unknown as { attachments?: unknown[] }).attachments, undefined);
  await get(`/q/${token}`, NOBODY);
  assert.equal((await db.sql`select who from quote_views where quote_id = ${id}::bigint`)[0].who, "scanner");
  assert.equal((await quoteById(db, id))!.viewed_at, null, "a scanner does not make it Viewed");
  // A new link: the old one stops working.
  const again = await post(`/invoices/quotes/${id}/proposal/link`, {});
  const fresh = tokenOf(await again.text());
  assert.notEqual(fresh, token);
  const dead = await get(`/q/${token}`, NOBODY);
  assert.equal(dead.status, 404);
  assert.match(await dead.text(), /This link no longer works\.[\s\S]*Ask Acme Test Co for a new one\./);
  await markEmailed(db, id);
});

test("the customer's link reads the business itself: a page made there, and the one they sign, names it with no team request first", async (t) => {
  if (skip) return t.skip(skip);
  const { deal } = await customerWithDeal("Bea Ng", "bea@example.com");
  const id = await newQuote("bea@example.com", "Bea Ng", deal);
  const token = tokenOf(await (await post(`/invoices/quotes/${id}/send`, { how: "link" })).text());
  // Renamed straight in the database: only a request that reads the business itself sees it, as a fresh
  // server or Worker would (before this, the link took whatever a team request had loaded: nothing, then "Us").
  await db.sql`update business set name = 'Bright Fence Co'`;
  try {
    const html = await (await get(`/q/${token}`, NOBODY)).text();
    assert.match(html, /Bright Fence Co/);
    assert.equal((await post(`/q/${token}`, { name: "Bea Ng", agree: "1", page: shaOf(html) }, NOBODY)).status, 303, "and signing it is not refused as changed");
    assert.equal((await quoteById(db, id))!.status, "accepted");
  } finally {
    await db.sql`update business set name = 'Acme Test Co'`;
  }
});

test("declined at the link: the quote declined, its deal lost with their reason; an expired or unknown link is dead", async (t) => {
  if (skip) return t.skip(skip);
  const { deal } = await customerWithDeal("Cy Lo", "cy@example.com");
  const id = await newQuote("cy@example.com", "Cy Lo", deal);
  const token = tokenOf(await (await post(`/invoices/quotes/${id}/send`, { how: "link" })).text());
  const html = await (await get(`/q/${token}`, NOBODY)).text();
  assert.match(html, /Decline it, and tell us why/);
  const res = await post(`/q/${token}/decline`, { reason: "Price", note: "Too much for now.", page: shaOf(html) }, NOBODY);
  assert.equal(res.status, 303);
  const qt = (await quoteById(db, id))!;
  assert.deepEqual([qt.status, qt.decided_by], ["declined", "declined online"]);
  const [d] = await db.sql`select stage, lost_reason from deals where id = ${deal}::bigint`;
  assert.deepEqual([d.stage, d.lost_reason], ["lost", "Price: Too much for now."]);
  assert.match(await (await get(`/q/${token}`, NOBODY)).text(), /You declined this quote/);

  // Past its date, a link says so and cannot be signed or declined; one that never was is dead; /q/ says it serves proposals.
  const other = await newQuote("cy@example.com", "Cy Lo", deal);
  const t2 = tokenOf(await (await post(`/invoices/quotes/${other}/send`, { how: "link" })).text());
  await db.sql`update quotes set valid_until = '2020-01-01' where id = ${other}::bigint`;
  const expired = await get(`/q/${t2}`, NOBODY);
  assert.equal(expired.status, 200);
  assert.match(await expired.text(), /has expired/);
  await post(`/q/${t2}/decline`, { reason: "Price", note: "" }, NOBODY);
  assert.equal((await quoteById(db, other))!.status, "sent", "nor can it decline");
  assert.equal((await get(`/q/${"A".repeat(43)}`, NOBODY)).status, 404);
  const q = await get("/q/", NOBODY);
  assert.equal(q.headers.get("x-proposals"), "1");
  assert.equal((await get("/invoices/quotes", NOBODY)).status, 404, "the rest stays the team's");
});

test("the morning: a proposal unsigned three days after it went, or three from expiring, gets a follow-up task, once; one opened since yesterday is in its maker's email", async (t) => {
  if (skip) return t.skip(skip);
  const { sendDigests } = await import("../src/crm/digest");
  const { todayIn } = await import("../src/invoices/document");
  const { deal } = await customerWithDeal("Di Moe", "di@example.com");
  const id = await newQuote("di@example.com", "Di Moe", deal);
  await post(`/invoices/quotes/${id}/send`, { how: "link" });
  const today = todayIn("UTC");
  await db.sql`update quotes set valid_until = ${today}::date + 2, viewed_at = now() - interval '2 hours' where id = ${id}::bigint`;
  const sent: { to: string; subject: string; text: string }[] = [];
  const send = async (m: { to: string; subject: string; text: string }) => (sent.push(m), { status: "sent" as const, via: "fake" });
  await sendDigests(db, send, { timeZone: "UTC", hour: 0, word: "Quote" });
  const tasks = await db.sql`select title, owner::text as owner, to_char(due_on, 'YYYY-MM-DD') as due from follow_ups where title like 'Follow up with Di Moe%'`;
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /not signed yet, open until /);
  assert.equal(tasks[0].owner, "pat@team.example");
  assert.equal(tasks[0].due, today);
  const mine = sent.find((m) => m.to === "pat@team.example")!;
  assert.match(mine.text, /Follow up with Di Moe on quote Q-\d{4}/);
  assert.match(mine.text, /Opened, not signed yet\n- Quote Q-\d{4} \(Di Moe\)/);
  // Run again tomorrow's way: no second task.
  await db.sql`delete from follow_up_digests`;
  await sendDigests(db, send, { timeZone: "UTC", hour: 0, word: "Quote" });
  assert.equal((await db.sql`select count(*)::int as n from follow_ups where title like 'Follow up with Di Moe%'`)[0].n, 1);

  // With no valid-until date: three days after it went.
  const { deal: d2 } = await customerWithDeal("Ed Noe", "ed@example.com");
  const other = await newQuote("ed@example.com", "Ed Noe", d2);
  await post(`/invoices/quotes/${other}/send`, { how: "link" });
  await db.sql`update quotes set valid_until = null where id = ${other}::bigint`;
  await db.sql`delete from follow_up_digests`;
  await sendDigests(db, send, { timeZone: "UTC", hour: 0, word: "Quote" });
  assert.equal((await db.sql`select count(*)::int as n from follow_ups where title like 'Follow up with Ed Noe%'`)[0].n, 0, "not the day it went");
  await db.sql`update quotes set sent_at = now() - interval '3 days' where id = ${other}::bigint`;
  await db.sql`delete from follow_up_digests`;
  await sendDigests(db, send, { timeZone: "UTC", hour: 0, word: "Quote" });
  assert.equal((await db.sql`select title from follow_ups where title like 'Follow up with Ed Noe%'`)[0]?.title, `Follow up with Ed Noe on quote Q-${other.padStart(4, "0")}: not signed yet`);
});

test("in production the edge's header says whether /q is open; a visitor's own header is the edge's to drop", async () => {
  const { Hono } = await import("hono");
  const { readyHere } = await import("../src/proposals/link");
  const saved = process.env.PROPOSAL_BASE_URL;
  delete process.env.PROPOSAL_BASE_URL;
  try {
    const app = new Hono();
    app.get("/", async (c) => c.text((await readyHere(c)) ?? "ready"));
    const ask = async (h: Record<string, string>) => (await app.request("https://crm.example/", { headers: { host: "crm.example", ...h } })).text();
    assert.equal(await ask({ "x-tasktool-public-paths": "/q" }), "ready");
    assert.equal(await ask({ "x-tasktool-public-paths": "/reports,/q" }), "ready");
    assert.match(await ask({}), /customers cannot open \/q\/ on production yet/);
  } finally {
    if (saved !== undefined) process.env.PROPOSAL_BASE_URL = saved;
  }
});

test("proposal-font: the latin faces, the weights each role uses, the token and the fonts block rewritten", () => {
  const sheet = (w: number, url: string, sub = "latin") => `/* ${sub} */\n@font-face {\n  font-family: 'X';\n  font-style: normal;\n  font-weight: ${w};\n  src: url(${url}) format('woff2');\n}\n`;
  const statics = latinFaces([400, 700, 900].map((w) => sheet(w, `https://g/x${w}.woff2`)).join("") + sheet(400, "https://g/ext.woff2", "latin-ext"));
  assert.deepEqual(statics.map((f: { min: number }) => f.min), [400, 700, 900], "latin only");
  assert.deepEqual(chooseFaces(statics, ["display"]).map((f: { min: number }) => f.min), [700]);
  assert.deepEqual(chooseFaces(statics, ["display", "body"]).map((f: { min: number }) => f.min), [700, 400]);
  const variable = latinFaces(sheet(400, "https://g/v.woff2") + sheet(700, "https://g/v.woff2"));
  assert.deepEqual(variable, [{ url: "https://g/v.woff2", min: 400, max: 700 }], "one file for a variable family");
  // A one-weight display face (Instrument Serif's 400) is said, with the weight shown instead; one that has them is not.
  const single = latinFaces(sheet(400, "https://g/one.woff2"));
  assert.deepEqual(missingWeights(chooseFaces(single, ["display"]), ["display"]), [{ role: "display", want: 700, shown: 400 }]);
  assert.deepEqual(missingWeights(chooseFaces(statics, ["display", "body"]), ["display", "body"]), []);
  assert.deepEqual(missingWeights(variable, ["display"]), []);

  const css = `${START}\n@font-face {\n  font-family: "Old";\n  src: url("/fonts/old.woff2");\n}\n${END}\n@theme {\n  --font-display: "Old", serif;\n  --font-body: "Old", sans-serif;\n}`;
  const once = rewrite(css, "New", ["display"], [{ url: "u", min: 700, max: 700 }])!;
  assert.match(once, /--font-display: "New", serif;/, "fallbacks kept");
  assert.match(once, /font-family: "Old"/, "still the body's");
  assert.match(once, /url\("\/fonts\/new-latin-700-normal\.woff2"\)/);
  const both = rewrite(once, "New", ["body"], [{ url: "u", min: 400, max: 700 }])!;
  assert.doesNotMatch(both, /"Old"/, "a family no token names loses its @font-face");
  assert.equal((both.match(/font-family: "New"/g) ?? []).length, 1, "the family's faces replaced, not added twice");
  assert.equal(rewrite("@theme {}", "New", ["body"], []), null, "no fonts block");
  // Display set again to the family body uses already: body's regular weight is kept.
  const sameForBoth = `--font-display: "Caladea", serif;\n  --font-body: "Caladea", serif;`;
  assert.deepEqual(rolesFor(sameForBoth, "Caladea", ["display"]), ["display", "body"]);
  assert.deepEqual(chooseFaces(statics, rolesFor(sameForBoth, "Caladea", ["display"])).map((f: { min: number }) => f.min).sort(), [400, 700]);
  assert.match(rewrite(`${START}\n${END}\n--font-display: Georgia, serif;`, "New", ["display"], [])!, /--font-display: "New", serif;/, "an unquoted family too");
});

test("proposal-photo: a photo cut and sized into brand/images/, the line to name it by", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "proposal-photo-"));
  try {
    const src = join(dir, "crew-on-roof-1a2b3c4d.png");
    const made = spawnSync("python3", ["-c", "import sys\nfrom PIL import Image\nImage.new('RGB', (3200, 1000), (200, 40, 40)).save(sys.argv[1])", src]);
    if (made.status !== 0) return t.skip("Pillow is not installed here");
    const script = join(process.cwd(), "scripts", "proposal-photo.mjs");
    const r = spawnSync("node", [script, src, "--crop", "0,0,25,0"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wrote brand\/images\/crew-on-roof\.webp from .*: 1600 x 667, \d+ KB, cut 25% right from 3200 x 1000/);
    assert.match(r.stdout, /photo\("brand\/images\/crew-on-roof\.webp"\)/);
    assert.ok(statSync(join(dir, "brand", "images", "crew-on-roof.webp")).size <= 600 * 1024);
    const again = spawnSync("node", [script, src, "--crop", "0,0,25,0"], { cwd: dir, encoding: "utf8" });
    assert.match(again.stdout, /replaced brand\/images\/crew-on-roof\.webp/, "safe to run twice");
    const named = spawnSync("node", [script, src, "--as", "Cover House.webp"], { cwd: dir, encoding: "utf8" });
    assert.match(named.stdout, /wrote brand\/images\/cover-house\.webp/, "--as with an extension names the file once");
    const bad = spawnSync("node", [script, src, "--crop", "60,0,40,0"], { cwd: dir, encoding: "utf8" });
    assert.equal(bad.status, 2, "a crop that leaves nothing is misuse");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proposal-copy: a component's words are read, titles and questions too; reviews, empty slots, stars and the quote's own words are not", () => {
  const html = `<h3>How we&#39;ll do it</h3><dl><dt>Do I need to be home?</dt><dd>No.</dd></dl><figure><blockquote>“Great!”</blockquote><figcaption>Ann, Google</figcaption></figure>`
    + `<div class="x" role="img" aria-label="A portrait"><span class="t">A portrait</span></div><p>★★★★★</p><p>The note.</p>`;
  assert.equal(wordsOf(html, ["The note."]), "How we'll do it\nDo I need to be home?\nNo.");
});

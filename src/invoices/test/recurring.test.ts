import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { applySchema } from "../../data/migrate";
import { invoicesAdmin } from "../admin";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import { StripeError, type Stripe } from "../../payments/stripe";
import { cardEvents, cardsFor, defaultCard } from "../cards";
import { addDays, todayIn } from "../document";
import { createInvoice, invoiceById } from "../invoices";
import {
  createRecurring, daysBetween, describe, describeForCustomer, endForQuote, invoicesOf, makeNow, pauseRecurring, periodOn, recurringById, resumeRecurring,
  runRecurring, saveRecurring, scheduleText, startFromQuote, type RecurringFields, type RunDeps,
} from "../recurring";
import { emailPaymentPage, sendInvoice } from "../stripe";

const here = dirname(fileURLToPath(import.meta.url));
const schemas = [join(here, "..", "..", "payments", "schema.sql"), join(here, "..", "schema.sql")].map((f) => readFileSync(f, "utf8"));
const BY = "pat@team.example";

async function withDb(t: { skip: (m: string) => void }, fn: (s: Scratch) => Promise<void>) {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    for (const sql of schemas) await applySchema(s.db, sql);
    await fn(s);
  } finally {
    await s.drop();
  }
}

type Card = { id: string; brand: string; last4: string };
/** Stripe's invoice ids are unique across the account, and so across these fakes. */
let invoiceSeq = 0;

/** A Stripe account with many invoices and a customer's cards; `decline` refuses every charge. */
function fakeStripe(opts: { cards?: Card[]; decline?: "card_declined" | "authentication_required" } = {}) {
  const calls: { method: string; path: string; params?: any; key?: string }[] = [];
  const invoices = new Map<string, { status: string; collection: string; items: number[] }>();
  const obj = (id: string) => {
    const i = invoices.get(id)!;
    const sub = i.items.reduce((a, b) => a + b, 0);
    return { id, status: i.status, number: i.status === "draft" ? null : `ACME-${id}`, hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
      invoice_pdf: null, due_date: i.collection === "send_invoice" ? 1_800_000_000 : null, subtotal: sub, total: sub, total_taxes: [] };
  };
  const stripe: Stripe = async (method, path, params, o) => {
    calls.push({ method, path, params, key: o?.idempotencyKey });
    const p = params as any;
    if (path === "/v1/balance") return { livemode: false } as any;
    if (path === "/v1/customers" && method === "POST") return { id: "cus_1" } as any;
    if (path === "/v1/customers/cus_1/payment_methods") return { data: (opts.cards ?? []).map((c) => ({ id: c.id, type: "card", customer: "cus_1", card: { brand: c.brand, last4: c.last4, exp_month: 1, exp_year: 2030 } })) } as any;
    if (path === "/v1/customers/cus_1") return { id: "cus_1", invoice_settings: { default_payment_method: null } } as any;
    if (path === "/v1/invoices" && method === "POST") {
      const id = `in_${++invoiceSeq}`;
      invoices.set(id, { status: "draft", collection: p.collection_method, items: [] });
      return { id } as any;
    }
    if (path === "/v1/invoiceitems") return (invoices.get(p.invoice)!.items.push(Number(p.amount)), { id: "ii" }) as any;
    const m = path.match(/^\/v1\/invoices\/(in_\d+)(?:\/(\w+))?$/);
    if (m) {
      const [, id, verb] = m;
      if (!verb) return obj(id) as any;
      if (verb === "finalize") invoices.get(id)!.status = "open";
      if (verb === "pay") {
        if (opts.decline === "authentication_required") throw new StripeError("This payment requires authentication.", 402, "card_error", "authentication_required");
        if (opts.decline) throw new StripeError("Your card was declined.", 402, "card_error", "card_declined");
        invoices.get(id)!.status = "paid";
      }
      return obj(id) as any;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { stripe, calls, invoices };
}

const plan = (over: RecurringFields = {}): RecurringFields => ({
  email: "ann@example.com", name: "Ann Lee", currency: "usd", title: "Maintenance plan", unit: "month", every: "1",
  first_on: "2026-11-01", mode: "send", lines: [{ description: "Monthly maintenance", quantity: "1", unit: "300.00" }], ...over,
});

function deps(today: string, stripe: Stripe, tasks: string[] = []): RunDeps {
  return { today, timeZone: "America/Denver", stripe: () => stripe, task: async (_r, t) => void tasks.push(`${t.due_on} ${t.title}`) };
}

async function made(s: Scratch, over: RecurringFields = {}) {
  const r = await createRecurring(s.db, plan(over), BY, "crm");
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

test("periods count from the first date: the 28th through a leap February, weeks over a year end, quarters, years", () => {
  assert.deepEqual([0, 1, 2, 3].map((n) => periodOn("2027-12-28", "month", 1, n)), ["2027-12-28", "2028-01-28", "2028-02-28", "2028-03-28"]);
  assert.deepEqual([0, 1, 2, 3].map((n) => periodOn("2026-12-21", "week", 2, n)), ["2026-12-21", "2027-01-04", "2027-01-18", "2027-02-01"]);
  assert.deepEqual([0, 1, 2].map((n) => periodOn("2026-11-15", "month", 3, n)), ["2026-11-15", "2027-02-15", "2027-05-15"]);
  assert.equal(periodOn("2026-02-01", "year", 1, 2), "2028-02-01");
  assert.equal(daysBetween("2026-11-01", "2026-11-04"), 3);
  assert.equal(scheduleText({ unit: "month", every: 1, first_on: "2026-11-01" }), "every month on the 1st");
  assert.equal(scheduleText({ unit: "week", every: 2, first_on: "2026-11-02" }), "every 2 weeks on Monday");
  assert.equal(scheduleText({ unit: "year", every: 1, first_on: "2026-11-22" }), "every year on November 22");
});

test("the run's today is the business's: either side of local midnight in Auckland and Honolulu, and the night Denver's clocks go back", () => {
  assert.equal(todayIn("Pacific/Auckland", new Date("2026-10-15T10:30:00Z")), "2026-10-15");
  assert.equal(todayIn("Pacific/Auckland", new Date("2026-10-15T11:30:00Z")), "2026-10-16");
  assert.equal(todayIn("Pacific/Honolulu", new Date("2026-10-15T09:30:00Z")), "2026-10-14");
  assert.equal(todayIn("Pacific/Honolulu", new Date("2026-10-15T10:30:00Z")), "2026-10-15");
  assert.equal(todayIn("America/Denver", new Date("2026-11-01T05:30:00Z")), "2026-10-31");
  assert.equal(todayIn("America/Denver", new Date("2026-11-01T06:30:00Z")), "2026-11-01");
  assert.equal(todayIn("America/Denver", new Date("2026-11-02T06:30:00Z")), "2026-11-01", "an hour later after the change");
});

test("a month's first date is the 1st to the 28th; a week's any day; ends on a date or after a count", async (t) => {
  await withDb(t, async (s) => {
    const bad = await createRecurring(s.db, plan({ first_on: "2026-11-30" }), BY, "crm");
    assert.ok(!bad.ok && bad.errors.first_on);
    const weekly = await createRecurring(s.db, plan({ unit: "week", first_on: "2026-11-30" }), BY, "crm");
    assert.ok(weekly.ok);
    const r = await made(s, { ends: "after", ends_after: "12", mode: "charge" });
    assert.equal(r.total_cents, "30000");
    assert.equal(describe(r, "Visa 4242"), "An invoice for $300.00, every month on the 1st from Nov 1, 2026 for 12 invoices (the last on Oct 1, 2027), charged to Visa 4242.");
    assert.equal(describeForCustomer(r), "From Nov 1, 2026: $300.00 every month on the 1st for 12 invoices (the last on Oct 1, 2027), charged to the card you first pay with online.");
  });
});

test("the run makes each period once and sends it; a second run that day makes nothing; next month the next one", async (t) => {
  await withDb(t, async (s) => {
    const r = await made(s);
    const { stripe, calls } = fakeStripe();
    const first = await runRecurring(s.db, deps("2026-10-31", stripe));
    assert.equal(first.made, 0, "not before its date");
    const on = await runRecurring(s.db, deps("2026-11-01", stripe));
    assert.deepEqual([on.made, on.sent, on.failed], [1, 1, 0]);
    const again = await runRecurring(s.db, deps("2026-11-01", stripe));
    assert.equal(again.made, 0);
    const [inv] = await invoicesOf(s.db, r.id);
    assert.equal(inv.status, "open");
    assert.equal(inv.period_on, "2026-11-01");
    assert.equal(inv.recurring_id, r.id);
    assert.equal(inv.due_date, addDays(todayIn("America/Denver"), 30), "due counts from the day it went, in the zone");
    assert.ok(calls.some((c) => c.path.endsWith("/send")));
    const dec = await runRecurring(s.db, deps("2026-12-01", stripe));
    assert.equal(dec.made, 1);
    const after = (await recurringById(s.db, r.id))!;
    assert.deepEqual([after.made, after.next_on], [2, "2027-01-01"]);
    assert.ok(after.checked_at);
  });
});

test("a run after skipped days makes every missed period; ones over two days late wait as drafts with a task", async (t) => {
  await withDb(t, async (s) => {
    const r = await made(s, { unit: "week", first_on: "2026-11-02" });
    const { stripe } = fakeStripe();
    const tasks: string[] = [];
    const res = await runRecurring(s.db, deps("2026-11-23", stripe, tasks));
    assert.deepEqual([res.made, res.drafts, res.sent], [4, 3, 1]);
    const invs = await invoicesOf(s.db, r.id);
    assert.deepEqual(invs.map((i) => [i.period_on, i.status]), [["2026-11-23", "open"], ["2026-11-16", "draft"], ["2026-11-09", "draft"], ["2026-11-02", "draft"]]);
    assert.equal(tasks.length, 3);
    assert.match(tasks[0], /^2026-11-23 Ann Lee's invoice for the week of Nov 2, 2026 was made 21 days late/);
  });
});

test("draft mode makes the draft days ahead, its task due on the date; an end after a count ends it", async (t) => {
  await withDb(t, async (s) => {
    const r = await made(s, { mode: "draft", days_ahead: "3", note_for_team: "add 12% of ad spend", ends: "after", ends_after: "1" });
    const { stripe, calls } = fakeStripe();
    const tasks: string[] = [];
    assert.equal((await runRecurring(s.db, deps("2026-10-28", stripe, tasks))).made, 0);
    const res = await runRecurring(s.db, deps("2026-10-29", stripe, tasks));
    assert.deepEqual([res.made, res.drafts, res.ended], [1, 1, 1]);
    assert.deepEqual(tasks, ["2026-11-01 Review Ann Lee's November 2026 invoice: add 12% of ad spend"]);
    assert.equal(calls.length, 0, "a draft never reaches Stripe");
    assert.equal((await recurringById(s.db, r.id))!.status, "ended");
  });
});

test("charge: no card emails it; a card is charged by name; a declined card leaves it open, noted, with a task", async (t) => {
  await withDb(t, async (s) => {
    await made(s, { mode: "charge" });
    const none = fakeStripe();
    const res = await runRecurring(s.db, deps("2026-11-01", none.stripe));
    assert.deepEqual([res.emailed, res.charged], [1, 0]);
    assert.equal([...none.invoices.values()][0].collection, "send_invoice");

    const card = fakeStripe({ cards: [{ id: "pm_visa", brand: "visa", last4: "4242" }] });
    const dec = await runRecurring(s.db, deps("2026-12-01", card.stripe));
    assert.equal(dec.charged, 1);
    const pay = card.calls.find((c) => c.path.endsWith("/pay"))!;
    assert.equal(pay.params.payment_method, "pm_visa");
    assert.equal([...card.invoices.values()][0].collection, "charge_automatically");
    assert.equal((await defaultCard(s.db, "ann@example.com", false))!.last4, "4242");
    const [dec1] = await s.db.sql<{ status: string }>`select status from invoices where period_on = '2026-12-01'`;
    assert.equal(dec1.status, "open", "Stripe answers paid: no longer a draft here, paid when the webhook says so");

    const tasks: string[] = [];
    const declined = fakeStripe({ cards: [{ id: "pm_visa", brand: "visa", last4: "4242" }], decline: "card_declined" });
    const jan = await runRecurring(s.db, deps("2027-01-01", declined.stripe, tasks));
    assert.equal(jan.failed, 1);
    assert.match(tasks[0], /^2027-01-01 Could not charge Ann Lee's January 2027 invoice: Visa 4242 was declined: Your card was declined\. Email them the payment page/);
    const inv = (await invoiceById(s.db, (await s.db.sql`select id::text as id from invoices where period_on = '2027-01-01'`)[0].id))!;
    assert.equal(inv.status, "open");
    assert.ok(inv.payment_failed_at && inv.sent_at);
  });
});

test("a charge the customer must confirm is reported as such", async (t) => {
  await withDb(t, async (s) => {
    const d = await createInvoice(s.db, { email: "ann@example.com", currency: "usd", lines: [{ description: "Fence", quantity: "1", unit: "100" }] }, BY, "crm");
    assert.ok(d.ok);
    const { stripe } = fakeStripe({ cards: [{ id: "pm_1", brand: "visa", last4: "1111" }], decline: "authentication_required" });
    const r = await sendInvoice(s.db, stripe, d.value.id, BY, { collect: "charge" });
    assert.ok(!r.ok && r.reason === "action");
    assert.match(r.message, /needs Ann|needs ann@example\.com to confirm/);
  });
});

test("pause and resume skip the missed dates; schedule fixed once an invoice is made", async (t) => {
  await withDb(t, async (s) => {
    const r = await made(s);
    const { stripe } = fakeStripe();
    await runRecurring(s.db, deps("2026-11-01", stripe));
    assert.ok(await pauseRecurring(s.db, r.id, BY));
    assert.equal((await runRecurring(s.db, deps("2026-12-01", stripe))).made, 0);
    assert.ok(await resumeRecurring(s.db, r.id, BY, "2027-02-10"));
    assert.equal((await recurringById(s.db, r.id))!.next_on, "2027-03-01");
    const moved = await saveRecurring(s.db, r.id, plan({ first_on: "2026-11-02" }), BY);
    assert.ok(!moved.ok && moved.errors.first_on);
    const pricier = await saveRecurring(s.db, r.id, plan({ lines: [{ description: "Monthly maintenance", quantity: "1", unit: "350" }] }), BY);
    assert.ok(pricier.ok && pricier.value.total_cents === "35000");

    // Paused before its first invoice: the resume skips the missed dates, and an edit afterwards keeps that.
    const early = await made(s, { email: "bo@example.com", ends: "after", ends_after: "3" });
    await pauseRecurring(s.db, early.id, BY);
    await resumeRecurring(s.db, early.id, BY, "2027-01-10");
    const renamed = await saveRecurring(s.db, early.id, plan({ email: "bo@example.com", title: "Care plan", ends: "after", ends_after: "3" }), BY);
    assert.ok(renamed.ok && renamed.value.next_on === "2027-02-01", "an edit does not bring back the skipped dates");
    assert.match(describe(renamed.value), /for 3 invoices \(the last on Apr 1, 2027\)/, "the last counts on from the next date, not the first");
    assert.equal((await runRecurring(s.db, deps("2027-01-10", stripe))).made, 0);
  });
});

test("make now: the next period as a draft, whatever its date", async (t) => {
  await withDb(t, async (s) => {
    const r = await made(s);
    const inv = await makeNow(s.db, r.id, deps("2026-10-15", fakeStripe().stripe));
    assert.ok(inv && inv.status === "draft" && inv.period_on === "2026-11-01");
    assert.equal((await recurringById(s.db, r.id))!.next_on, "2026-12-01");

    const once = await made(s, { email: "bo@example.com", ends: "after", ends_after: "1" });
    await makeNow(s.db, once.id, deps("2026-10-15", fakeStripe().stripe));
    assert.equal((await recurringById(s.db, once.id))!.status, "ended", "its last invoice made: ended at once, not at the next run");
  });
});

test("a quote's yes starts its pending one: the first invoice at once when its date has come; a no ends it", async (t) => {
  await withDb(t, async (s) => {
    const yes = await createRecurring(s.db, plan({ mode: "charge", first_on: "2026-10-01" }), BY, "crm", { pending: { quoteId: "7" } });
    const no = await createRecurring(s.db, plan(), BY, "crm", { pending: { quoteId: "8" } });
    assert.ok(yes.ok && no.ok);
    const { stripe } = fakeStripe({ cards: [{ id: "pm_visa", brand: "visa", last4: "4242" }] });
    assert.equal((await runRecurring(s.db, deps("2026-10-14", stripe))).made, 0, "the run never reads a pending one");
    const [started] = await startFromQuote(s.db, "7", deps("2026-10-14", stripe));
    assert.equal(started.first?.outcome, "charged", "signed after its first date: made and charged at once, not late");
    assert.deepEqual([started.recurring.status, started.recurring.next_on], ["active", "2026-11-01"]);
    await endForQuote(s.db, "8", BY);
    assert.equal((await recurringById(s.db, no.value.id))!.status, "ended");
  });
});

test("card events: the first card is the default; removing it falls to the next; the owner's choice in Stripe wins", async (t) => {
  await withDb(t, async (s) => {
    await s.db.sql`insert into stripe_customers (email, livemode, stripe_customer_id) values ('ann@example.com', false, 'cus_1')`;
    const ev = (id: string, type: string, object: any) => ({ id, type, created: 1, data: { object } }) as any;
    const pm = (id: string, last4: string) => ({ id, type: "card", customer: "cus_1", livemode: false, card: { brand: "visa", last4 } });
    await cardEvents.apply(s.db, ev("evt_1", "payment_method.attached", pm("pm_a", "1111")));
    await cardEvents.apply(s.db, ev("evt_2", "payment_method.attached", pm("pm_b", "2222")));
    await cardEvents.apply(s.db, ev("evt_x", "payment_method.attached", { ...pm("pm_z", "9999"), customer: "cus_other" }));
    assert.deepEqual((await cardsFor(s.db, "ann@example.com")).map((c) => [c.last4, c.isDefault]), [["1111", true], ["2222", false]]);
    await cardEvents.apply(s.db, ev("evt_3", "customer.updated", { id: "cus_1", invoice_settings: { default_payment_method: "pm_b" } }));
    assert.equal((await defaultCard(s.db, "ann@example.com", false))!.last4, "2222");
    await cardEvents.apply(s.db, ev("evt_4", "payment_method.detached", { id: "pm_b", type: "card", customer: null }));
    assert.deepEqual((await cardsFor(s.db, "ann@example.com")).map((c) => [c.last4, c.isDefault]), [["1111", true]]);
    await cardEvents.apply(s.db, ev("evt_2", "payment_method.attached", pm("pm_b", "2222")));
    assert.deepEqual((await cardsFor(s.db, "ann@example.com")).map((c) => c.last4), ["1111"], "a removed card stays removed when its attach comes again");
  });
});

test("the pages: make one, read what happens, a charged invoice from Send, a card chosen", async (t) => {
  await withDb(t, async (s) => {
    const f = fakeStripe({ cards: [{ id: "pm_visa", brand: "visa", last4: "4242" }, { id: "pm_mc", brand: "mastercard", last4: "5555" }] });
    const app = new Hono();
    app.route("/invoices", invoicesAdmin(() => s.db, { base: "/invoices", css: "/site.css", source: "crm", timeZone: "America/Denver", stripe: () => f.stripe }));
    const HOST = "https://crm.example";
    const headers = { "x-tasktool-user": BY, origin: HOST, host: "crm.example" };
    const get = (p: string) => app.request(HOST + p, { headers });
    const post = (p: string, data: Record<string, string | string[]> = {}) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(data)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
      return app.request(HOST + p, { method: "POST", body, headers: { ...headers, "content-type": "application/x-www-form-urlencoded" } });
    };
    assert.match(await (await get("/invoices/recurring")).text(), /No recurring invoices yet/);
    const bad = await post("/invoices/recurring", { email: "ann@example.com", currency: "usd", title: "Plan", period: "month", every: "1", first_on: "2026-11-30", mode: "send", description: "Care", unit: "300", quantity: "1" });
    assert.equal(bad.status, 422);
    let res = await post("/invoices/recurring", {
      email: "ann@example.com", name: "Ann Lee", currency: "usd", title: "Maintenance plan", every: "1", first_on: "2026-11-01", ends: "never",
      mode: "charge", days_ahead: "3", days_until_due: "30", period: "month", description: ["Monthly care", ""], quantity: ["1", ""], unit: ["300", ""],
    });
    assert.equal(res.status, 303, await res.text());
    const id = /\/invoices\/recurring\/(\d+)\?saved=recurring-created/.exec(res.headers.get("location")!)![1];
    let html = await (await get(`/invoices/recurring/${id}`)).text();
    assert.match(html, /An invoice for \$300\.00, every month on the 1st from Nov 1, 2026, charged to their card \(emailed to pay until one is on file\)\./);
    assert.match(await (await get("/invoices/recurring")).text(), /Recurring invoices are not being made yet/);

    // Send, with a card on file: Charge is offered beside Email it to pay.
    const d = await createInvoice(s.db, { email: "ann@example.com", currency: "usd", lines: [{ description: "Fence", quantity: "1", unit: "100" }] }, BY, "crm");
    assert.ok(d.ok);
    await s.db.sql`insert into stripe_customers (email, livemode, stripe_customer_id) values ('ann@example.com', false, 'cus_1')`;
    const { syncCards } = await import("../cards");
    await syncCards(s.db, f.stripe, "cus_1", false);
    html = await (await get(`/invoices/${d.value.id}/send`)).text();
    assert.match(html, /Charge Visa 4242/);
    res = await post(`/invoices/${d.value.id}/send`, { collect: "charge" });
    assert.match(res.headers.get("location")!, /saved=invoice-charged$/);
    assert.equal(f.calls.find((c) => c.path.endsWith("/pay"))!.params.payment_method, "pm_visa");

    res = await post("/invoices/cards/pm_mc/default", { back: "/customers/4" });
    assert.match(res.headers.get("location")!, /^\/customers\/4\?saved=card-default$/, "back to the customer's page it was pressed on");
    assert.equal((await defaultCard(s.db, "ann@example.com", false))!.last4, "5555");
    html = await (await get(`/invoices/recurring/${id}`)).text();
    assert.match(html, /charged to Mastercard 5555/);
  });
});

test("on a quote: New invoice starts from its lines and goes on it, a draft is attached or detached, Make it repeat replaces a draft", async (t) => {
  await withDb(t, async (s) => {
    const { createQuote } = await import("../quotes");
    const app = new Hono();
    app.route("/invoices", invoicesAdmin(() => s.db, { base: "/invoices", css: "/site.css", source: "crm", timeZone: "America/Denver", stripe: () => fakeStripe().stripe }));
    const HOST = "https://crm.example";
    const headers = { "x-tasktool-user": BY, origin: HOST, host: "crm.example" };
    const get = (p: string) => app.request(HOST + p, { headers });
    const post = (p: string, data: Record<string, string | string[]> = {}) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(data)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
      return app.request(HOST + p, { method: "POST", body, headers: { ...headers, "content-type": "application/x-www-form-urlencoded" } });
    };
    const q = await createQuote(s.db, { email: "ann@example.com", name: "Ann Lee", currency: "usd", lines: [{ description: "Fence", unit: "2000" }] }, BY, "crm");
    assert.ok(q.ok);
    const qid = q.value.id;

    // New invoice from the quote: its customer and lines, One invoice or Repeats; saved, it is on the quote.
    let html = await (await get(`/invoices/new?quote=${qid}`)).text();
    assert.match(html, /value="Fence"/);
    assert.match(html, new RegExp(`aria-current="page"[^>]*>One invoice</a><a href="/invoices/recurring/new\\?quote=${qid}"`));
    let res = await post("/invoices", { email: "bob@example.com", currency: "usd", quote_id: qid, days_until_due: "30", description: "Deposit", unit: "500", quantity: "1" });
    assert.equal(res.status, 422, "only the quote's own customer");
    res = await post("/invoices", { email: "ann@example.com", currency: "usd", quote_id: qid, days_until_due: "30", description: "Deposit", unit: "500", quantity: "1" });
    assert.match(res.headers.get("location")!, new RegExp(`/invoices/quotes/${qid}\\?saved=invoice-attached$`));
    const [dep] = await s.db.sql`select id::text as id from invoices where quote_id = ${qid}::bigint`;
    html = await (await get(`/invoices/quotes/${qid}`)).text();
    assert.match(html, /When they say yes/);
    assert.match(html, new RegExp(`action="/invoices/${dep.id}/detach"`));
    assert.match(await (await get(`/invoices/${dep.id}`)).text(), /Sent to pay when they say yes/);

    // Detached, it is one of their drafts the quote's page offers to attach again.
    res = await post(`/invoices/${dep.id}/detach`);
    assert.match(res.headers.get("location")!, /saved=invoice-detached$/);
    html = await (await get(`/invoices/quotes/${qid}`)).text();
    assert.match(html, new RegExp(`<option value="${dep.id}">Draft, \\$500\\.00`));
    res = await post(`/invoices/quotes/${qid}/attach`, { invoice: dep.id });
    assert.match(res.headers.get("location")!, /saved=invoice-attached$/);

    // Make it repeat: the recurring form from the draft (and its quote); saved, the draft is gone, so it is never sent twice.
    html = await (await get(`/invoices/recurring/new?invoice=${dep.id}`)).text();
    assert.match(html, /Make it repeat/);
    assert.match(html, /value="Deposit"/);
    assert.match(html, new RegExp(`name="quote_id" value="${qid}"`));
    res = await post("/invoices/recurring", {
      email: "ann@example.com", currency: "usd", title: "Monthly care", period: "month", every: "1", first_on: "2026-12-01", ends: "never",
      mode: "send", days_ahead: "3", days_until_due: "30", description: "Care", unit: "500", quantity: "1", quote_id: qid, from_invoice: dep.id,
    });
    assert.match(res.headers.get("location")!, /saved=recurring-pending$/);
    assert.equal((await invoiceById(s.db, dep.id))!.status, "void");
    const [r] = await s.db.sql`select status from recurring_invoices where quote_id = ${qid}::bigint`;
    assert.equal(r.status, "pending", "it starts at their yes");
  });
});

test("the payment page: Stripe emails an emailed invoice's; a charged one's goes through the owner's sender, or its link is given", async (t) => {
  await withDb(t, async (s) => {
    const make = async () => {
      const d = await createInvoice(s.db, { email: "ann@example.com", name: "Ann Lee", currency: "usd", lines: [{ description: "Care", quantity: "1", unit: "60" }] }, BY, "crm");
      assert.ok(d.ok);
      return d.value.id;
    };
    const declined = fakeStripe({ cards: [{ id: "pm_1", brand: "visa", last4: "0341" }], decline: "card_declined" });
    const charged = await make();
    await sendInvoice(s.db, declined.stripe, charged, BY, { collect: "charge" });
    const mails: { to: string[]; subject: string; text: string }[] = [];
    const mail = { send: async (m: any) => (mails.push(m), { status: "sent" as const, via: "resend" }), business: "Acme" };
    const r = await emailPaymentPage(s.db, declined.stripe, charged, mail);
    assert.ok(r.ok);
    assert.equal(declined.calls.filter((c) => c.path.endsWith("/send")).length, 0, "Stripe is never asked to email a charged invoice");
    assert.deepEqual(mails[0].to, ["ann@example.com"]);
    assert.match(mails[0].subject, /your payment did not go through/);
    assert.match(mails[0].text, /We could not take the payment of \$60\.00 .*\nhttps:\/\/invoice\.stripe\.com\/i\/in_\d+\n\nAcme$/s);
    const none = await emailPaymentPage(s.db, declined.stripe, charged);
    assert.ok(!none.ok && /Send them its payment page yourself: https:\/\/invoice\.stripe\.com/.test(none.message));

    const emailed = await make();
    const f = fakeStripe();
    await sendInvoice(s.db, f.stripe, emailed, BY);
    assert.ok((await emailPaymentPage(s.db, f.stripe, emailed, mail)).ok);
    assert.equal(f.calls.filter((c) => c.path.endsWith("/send")).length, 2, "sent, then sent again by Stripe");
    assert.equal(mails.length, 1, "and not through the owner's sender");
  });
});

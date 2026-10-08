import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { applySchema } from "../../data/migrate";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import { StripeError, type Stripe } from "../../payments/stripe";
import { stripeWebhook } from "../../payments/webhook";
import { invoicesAdmin } from "../admin";
import { createInvoice, invoiceById } from "../invoices";
import { createTaxRate } from "../../payments/tax";
import { markPaidOutOfBand, sendInvoice, voidInvoice } from "../stripe";
import { invoiceEvents } from "../webhook";

const here = dirname(fileURLToPath(import.meta.url));
const schemas = [join(here, "..", "..", "payments", "schema.sql"), join(here, "..", "schema.sql")].map((f) => readFileSync(f, "utf8"));
const SECRET = "whsec_invoices_test";
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

type Call = { method: string; path: string; params?: Record<string, any>; key?: string };

/** A Stripe that keeps one invoice's state, answers like the API, and can fail a path once. */
function fakeStripe(opts: { livemode?: boolean; failOnce?: string; id?: string } = {}) {
  const sid = opts.id ?? "in_1";
  const calls: Call[] = [];
  const items: { amount: number; key: string }[] = [];
  let status = "draft";
  let failed = false;
  const inv = () => ({
    id: sid, status, number: status === "draft" ? null : "ACME-0001", hosted_invoice_url: status === "draft" ? null : "https://invoice.stripe.com/i/1",
    invoice_pdf: status === "draft" ? null : "https://pay.stripe.com/invoice/1/pdf", due_date: status === "draft" ? null : 1_800_000_000,
    subtotal: items.reduce((n, i) => n + i.amount, 0), total: items.reduce((n, i) => n + i.amount, 0) + 1000,
    total_taxes: [{ amount: 1000 }], livemode: opts.livemode ?? false,
  });
  const stripe: Stripe = async (method, path, params, o) => {
    calls.push({ method, path, params: params as any, key: o?.idempotencyKey });
    if (opts.failOnce && path.endsWith(opts.failOnce) && !failed) {
      failed = true;
      throw new StripeError("Stripe is having a moment", 500, "api_error");
    }
    if (path === "/v1/balance") return { livemode: opts.livemode ?? false } as any;
    if (path === "/v1/customers") return { id: "cus_1" } as any;
    if (path === "/v1/tax_rates") return { id: "txr_1" } as any;
    if (path === "/v1/invoices") return { id: sid } as any;
    if (path === "/v1/invoiceitems") {
      if (!items.some((i) => i.key === o?.idempotencyKey)) items.push({ amount: Number((params as any).amount), key: o!.idempotencyKey! });
      return { id: "ii" } as any;
    }
    if (path === `/v1/invoices/${sid}` && method === "GET") return inv() as any;
    if (path === `/v1/invoices/${sid}/finalize`) return ((status = "open"), inv()) as any;
    if (path.startsWith(`/v1/invoices/${sid}/`)) return inv() as any;
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { stripe, calls, items };
}

async function draft(s: Scratch, lines = [{ description: "Fence", quantity: "2", unit: "50.00", tax_rate_id: "" }]) {
  const r = await createInvoice(s.db, { email: "Ann@Example.com", name: "Ann Lee", currency: "usd", lines }, BY, "crm");
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

let n = 0;
function hook(s: Scratch) {
  const app = new Hono();
  app.route("/", stripeWebhook(() => s.db, { secret: () => SECRET, more: [invoiceEvents] }));
  return (type: string, object: object, id = `evt_${++n}_${Date.now()}`) => {
    const body = JSON.stringify({ id, type, created: Math.floor(Date.now() / 1000), data: { object } });
    const t = String(Math.floor(Date.now() / 1000));
    const v1 = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
    return app.request("https://hooks.example/hooks/stripe", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${v1}`, "content-type": "application/json" }, body });
  };
}

const stripeInvoice = (status: string, extra: object = {}) => ({
  id: "in_live_1", object: "invoice", status, number: "ACME-0007", hosted_invoice_url: "https://invoice.stripe.com/i/7", invoice_pdf: "https://pay.stripe.com/7/pdf",
  customer: "cus_9", customer_email: "ann@example.com", livemode: true, subtotal: 10000, total: 10000, total_taxes: [], amount_paid: status === "paid" ? 10000 : 0,
  due_date: 1_800_000_000, status_transitions: { paid_at: status === "paid" ? 1_790_000_000 : null }, metadata: {}, ...extra,
});

test("send with Stripe: customer, tax rate, invoice, items, finalize, send; the number and links stored", (t) =>
  withDb(t, async (s) => {
    const rate = await createTaxRate(s.db, { name: "Sales tax", percent: "10" }, BY);
    assert.ok(rate.ok);
    const inv = await draft(s, [{ description: "Fence", quantity: "2", unit: "50.00", tax_rate_id: rate.value.id }]);
    const f = fakeStripe();
    const r = await sendInvoice(s.db, f.stripe, inv.id, BY);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.invoice.status, "open");
    assert.equal(r.invoice.number, "ACME-0001");
    assert.equal(r.invoice.hosted_url, "https://invoice.stripe.com/i/1");
    assert.equal(r.invoice.due_date, "2027-01-15");
    assert.equal(r.invoice.total_cents, "11000");
    assert.equal(r.invoice.livemode, false);
    assert.ok(r.invoice.sent_at);
    const posts = f.calls.filter((c) => c.method === "POST");
    assert.deepEqual(posts.map((c) => c.path), ["/v1/customers", "/v1/tax_rates", "/v1/invoices", "/v1/invoiceitems", "/v1/invoices/in_1/finalize", "/v1/invoices/in_1/send"]);
    for (const c of posts) assert.ok(c.key?.includes(inv.match_key) || c.key?.startsWith("taxrate-"), `${c.path} keyed by the invoice`);
    const made = posts.find((c) => c.path === "/v1/invoices")!.params!;
    assert.equal(made.collection_method, "send_invoice");
    assert.equal(made.days_until_due, 30);
    assert.deepEqual(made.metadata, { invoice_id: inv.id, invoice_key: inv.match_key });
    const item = posts.find((c) => c.path === "/v1/invoiceitems")!.params!;
    assert.deepEqual({ amount: item.amount, invoice: item.invoice, tax_rates: item.tax_rates, description: item.description },
      { amount: 10000, invoice: "in_1", tax_rates: ["txr_1"], description: "Fence (2 x $50.00)" });
    assert.equal(posts.find((c) => c.path === "/v1/tax_rates")!.params!.percentage, "10");

    // Sent: it no longer sends, and the next invoice for the same email reuses the customer and the rate.
    assert.deepEqual((await sendInvoice(s.db, f.stripe, inv.id, BY)).ok, false);
    const next = await draft(s, [{ description: "More", quantity: "1", unit: "10", tax_rate_id: rate.value.id }]);
    const g = fakeStripe({ id: "in_2" });
    assert.ok((await sendInvoice(s.db, g.stripe, next.id, BY)).ok);
    assert.ok(!g.calls.some((c) => c.path === "/v1/customers" || c.path === "/v1/tax_rates"));
    assert.equal(g.calls.find((c) => c.path === "/v1/invoices")!.params!.customer, "cus_1");
  }));

test("a send that fails part way is finished by sending again, without a second line", (t) =>
  withDb(t, async (s) => {
    const inv = await draft(s);
    const f = fakeStripe({ failOnce: "/finalize" });
    const first = await sendInvoice(s.db, f.stripe, inv.id, BY);
    assert.deepEqual(first, { ok: false, reason: "stripe", message: "Stripe is having a moment" });
    const mid = await invoiceById(s.db, inv.id);
    assert.equal(mid!.status, "draft");
    assert.equal(mid!.stripe_invoice_id, "in_1", "stored at once: the draft no longer changes here");
    const again = await sendInvoice(s.db, f.stripe, inv.id, BY);
    assert.ok(again.ok);
    assert.equal(f.items.length, 1);
    assert.equal(f.calls.filter((c) => c.path === "/v1/invoices").length, 1, "the invoice is made once");
  }));

test("an empty or non-draft invoice is not sent; mark paid and void ask Stripe and change nothing here", (t) =>
  withDb(t, async (s) => {
    const f = fakeStripe();
    const zero = await draft(s, [{ description: "Free", quantity: "1", unit: "0", tax_rate_id: "" }]);
    assert.equal((await sendInvoice(s.db, f.stripe, zero.id, BY)).ok, false);
    assert.equal(f.calls.length, 0);
    const inv = await draft(s);
    assert.equal((await markPaidOutOfBand(s.db, f.stripe, inv.id)).ok, false, "never sent");
    await sendInvoice(s.db, f.stripe, inv.id, BY);
    const paid = await markPaidOutOfBand(s.db, f.stripe, inv.id);
    assert.ok(paid.ok);
    const call = f.calls.at(-1)!;
    assert.deepEqual([call.path, call.params, call.key], ["/v1/invoices/in_1/pay", { paid_out_of_band: true }, `pay-${inv.match_key}`]);
    assert.equal((await invoiceById(s.db, inv.id))!.status, "open", "paid only when Stripe's event says so");
    assert.ok((await voidInvoice(s.db, f.stripe, inv.id)).ok);
    assert.equal((await invoiceById(s.db, inv.id))!.status, "open");
  }));

test("webhook: paid before finalized, events again, the payment and its intent once, a refund on it", (t) =>
  withDb(t, async (s) => {
    const send = hook(s);
    const inv = await draft(s);
    await s.db.sql`update invoices set stripe_invoice_id = 'in_live_1', status = 'open', sent_at = now() where id = ${inv.id}::bigint`;

    // invoice_payment.paid first (2025+ API versions name the intent only there), then invoice.paid, then finalized.
    const payment = { id: "inpay_1", object: "invoice_payment", invoice: "in_live_1", status: "paid", amount_paid: 10000, currency: "usd", livemode: true,
      payment: { type: "payment_intent", payment_intent: "pi_1" }, status_transitions: { paid_at: 1_790_000_000 } };
    assert.equal((await send("invoice_payment.paid", payment)).status, 200);
    const paidEvent = `evt_paid_${Date.now()}`;
    assert.equal((await send("invoice.paid", stripeInvoice("paid"), paidEvent)).status, 200);
    assert.equal((await send("invoice.paid", stripeInvoice("paid"), paidEvent)).status, 200); // redelivered
    await send("invoice.finalized", stripeInvoice("open"));
    await send("invoice.voided", stripeInvoice("void")); // late and wrong: paid stays paid

    const after = await invoiceById(s.db, inv.id);
    assert.equal(after!.status, "paid");
    assert.equal(after!.number, "ACME-0007");
    assert.equal(after!.livemode, true);
    assert.equal(after!.paid_at!.toISOString(), new Date(1_790_000_000 * 1000).toISOString());
    const pays = await s.db.sql`select * from payments where ref_type = 'invoice' and ref_id = ${inv.id}`;
    assert.equal(pays.length, 1);
    assert.deepEqual({ status: pays[0].status, kind: pays[0].kind, amount: String(pays[0].amount_cents), intent: pays[0].stripe_payment_intent_id, email: pays[0].email, livemode: pays[0].livemode },
      { status: "paid", kind: "invoice", amount: "10000", intent: "pi_1", email: "ann@example.com", livemode: true });

    // A refund through the payments skill finds the row by its intent.
    await send("charge.refunded", { id: "ch_1", object: "charge", payment_intent: "pi_1", amount_refunded: 10000, refunded: true, created: 1_790_000_000 });
    assert.equal((await s.db.sql`select status from payments where id = ${pays[0].id}`)[0].status, "refunded");
  }));

test("webhook: invoice.paid first leaves the intent to the invoice_payment that follows; out of band has none", (t) =>
  withDb(t, async (s) => {
    const send = hook(s);
    const a = await draft(s);
    await s.db.sql`update invoices set stripe_invoice_id = 'in_live_1', status = 'open' where id = ${a.id}::bigint`;
    await send("invoice.paid", stripeInvoice("paid"));
    let [p] = await s.db.sql`select * from payments where ref_id = ${a.id}`;
    assert.equal(p.stripe_payment_intent_id, null);
    await send("invoice_payment.paid", { id: "inpay_2", invoice: "in_live_1", status: "paid", amount_paid: 10000, payment: { type: "payment_intent", payment_intent: "pi_2" } });
    [p] = await s.db.sql`select * from payments where ref_id = ${a.id}`;
    assert.equal(p.stripe_payment_intent_id, "pi_2");
    assert.equal((await s.db.sql`select count(*)::int as n from payments`)[0].n, 1);

    // Found by its metadata before the send stored the Stripe id; uncollectible, then paid.
    const b = await draft(s);
    const meta = { invoice_id: b.id, invoice_key: b.match_key };
    await send("invoice.finalized", stripeInvoice("open", { id: "in_live_2", metadata: meta }));
    let row = await invoiceById(s.db, b.id);
    assert.equal(row!.status, "open");
    assert.equal(row!.stripe_invoice_id, "in_live_2");
    await send("invoice.payment_failed", stripeInvoice("open", { id: "in_live_2" }));
    assert.ok((await invoiceById(s.db, b.id))!.payment_failed_at);
    await send("invoice.marked_uncollectible", stripeInvoice("uncollectible", { id: "in_live_2" }));
    assert.equal((await invoiceById(s.db, b.id))!.status, "uncollectible");
    await send("invoice.paid", stripeInvoice("paid", { id: "in_live_2" }));
    assert.equal((await invoiceById(s.db, b.id))!.status, "paid");

    // Another project's invoice on the same account (same id here, another key), and the platform's own: nothing changes.
    const c = await draft(s);
    await send("invoice.finalized", stripeInvoice("open", { id: "in_other", metadata: { invoice_id: c.id, invoice_key: "not-this-one" } }));
    await send("invoice.paid", stripeInvoice("paid", { id: "in_platform_sub" }));
    row = await invoiceById(s.db, c.id);
    assert.equal(row!.status, "draft");
    assert.equal(row!.stripe_invoice_id, null);
    assert.equal((await s.db.sql`select count(*)::int as n from payments`)[0].n, 2);

    // A Stripe draft deleted before it was sent: void here, never deleted.
    await s.db.sql`update invoices set stripe_invoice_id = 'in_deleted' where id = ${c.id}::bigint`;
    await send("invoice.deleted", { id: "in_deleted", object: "invoice", status: "draft", metadata: {} });
    assert.equal((await invoiceById(s.db, c.id))!.status, "void");
  }));

test("the pages: a GET asks, the POST sends; Mark paid waits for Stripe; from a quote once", (t) =>
  withDb(t, async (s) => {
    const f = fakeStripe();
    const went: string[] = [];
    const app = new Hono();
    app.route("/invoices", invoicesAdmin(() => s.db, {
      base: "/invoices", css: "/site.css", source: "crm", timeZone: "UTC", business: "Acme", stripe: () => f.stripe,
      send: async () => ({ status: "none", why: "test" }),
      afterSend: async (_c, doc) => void went.push(`${doc.kind} ${doc.email}`),
    }));
    const HOST = "https://crm.example";
    const headers = { "x-tasktool-user": BY, origin: HOST, host: "crm.example" };
    const get = (p: string) => app.request(HOST + p, { headers });
    const post = (p: string, data: Record<string, string | string[]> = {}) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(data)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
      return app.request(HOST + p, { method: "POST", body, headers: { ...headers, "content-type": "application/x-www-form-urlencoded" } });
    };

    let res = await post("/invoices", { email: "ann@example.com", name: "Ann", currency: "usd", days_until_due: "14", notes: "", visit_id: "", description: ["Visit", ""], quantity: ["", ""], unit: ["90", ""], tax_rate_id: ["", ""] });
    assert.equal(res.status, 303);
    const id = /\/invoices\/(\d+)\?saved=invoice-created/.exec(res.headers.get("location")!)![1];
    let html = await (await get(`/invoices/${id}`)).text();
    assert.match(html, /Send with Stripe/);
    assert.match(html, /Discard this draft/);

    html = await (await get(`/invoices/${id}/send`)).text();
    assert.match(html, /emails it to ann@example\.com: \$90\.00, due 14 days after it is sent/);
    assert.equal(f.calls.length, 0, "the page sends nothing");
    res = await post(`/invoices/${id}/send`);
    assert.match(res.headers.get("location")!, /saved=invoice-sent$/);
    assert.deepEqual(went, ["invoice ann@example.com"], "afterSend runs once Stripe has sent it");
    html = await (await get(`/invoices/${id}`)).text();
    assert.match(html, /Invoice ACME-0001/);
    assert.match(html, /href="https:\/\/invoice\.stripe\.com\/i\/1"/);
    assert.match(html, /Stripe test mode/);
    assert.equal((await get(`/invoices/${id}/edit`)).status, 302, "no edits once in Stripe");

    res = await post(`/invoices/${id}/paid`);
    assert.match(res.headers.get("location")!, /saved=asked-paid$/);
    assert.equal((await invoiceById(s.db, id))!.status, "open");

    // A Stripe refusal comes back on the page, as Stripe said it.
    const refusing: Stripe = async () => { throw new StripeError("This API key cannot void invoices", 403); };
    const app2 = new Hono();
    app2.route("/invoices", invoicesAdmin(() => s.db, { base: "/invoices", css: "/x.css", source: "crm", timeZone: "UTC", business: "", stripe: () => refusing }));
    res = await app2.request(HOST + `/invoices/${id}/void`, { method: "POST", headers });
    assert.match(decodeURIComponent(res.headers.get("location")!.replace(/\+/g, " ")), /\/void\?problem=This API key cannot void invoices/);

    // From an accepted quote, once.
    await s.db.sql`insert into quotes (number, email, currency, status, total_cents, subtotal_cents) values ('Q-9', 'bo@example.com', 'usd', 'accepted', 500, 500)`;
    const [{ qid }] = await s.db.sql`select id::text as qid from quotes where number = 'Q-9'`;
    await s.db.sql`insert into quote_lines (quote_id, position, description, quantity, unit_cents, amount_cents) values (${qid}::bigint, 1, 'Thing', 1, 500, 500)`;
    html = await (await get(`/invoices/quotes/${qid}`)).text();
    assert.match(html, /Make the invoice/);
    res = await post(`/invoices/quotes/${qid}/invoice`);
    const first = res.headers.get("location")!;
    assert.match(first, /\/invoices\/\d+\?saved=invoice-created$/);
    res = await post(`/invoices/quotes/${qid}/invoice`);
    assert.equal(res.headers.get("location"), first.replace("invoice-created", "invoiced"));
    assert.match(await (await get(`/invoices/quotes/${qid}`)).text(), /The draft invoice<\/a>, draft/);
  }));

test("a proposal's Pay button: the invoice made in Stripe without its email, the link in the quote, paying it accepts the quote", (t) =>
  withDb(t, async (s) => {
    const { createQuote, quoteById, markSent } = await import("../quotes");
    const { payLinkForQuote } = await import("../stripe");
    const { quoteMessage } = await import("../document");
    const q = await createQuote(s.db, { email: "ann@example.com", name: "Ann", currency: "usd", lines: [{ description: "Fence", quantity: "1", unit: "100.00" }] }, BY, "crm");
    assert.ok(q.ok);
    await markSent(s.db, q.value.id, BY);
    const f = fakeStripe();
    // The invoice's lines must be in Stripe before it finalizes: the fake keeps them.
    const link = await payLinkForQuote(s.db, f.stripe, q.value.id, BY, "crm");
    assert.ok(link.ok, JSON.stringify(link));
    assert.equal(link.url, "https://invoice.stripe.com/i/1");
    assert.ok(!f.calls.some((c) => c.path.endsWith("/send")), "Stripe emails nothing: the quote carries the link");
    const again = await payLinkForQuote(s.db, f.stripe, q.value.id, BY, "crm");
    assert.ok(again.ok && again.url === link.url, "asked twice, one invoice");
    assert.equal(f.calls.filter((c) => c.path === "/v1/invoices").length, 1);
    const full = await quoteById(s.db, q.value.id);
    assert.match(quoteMessage(full!, [], { business: "Acme" }, link.url).text, /To accept and pay: https:\/\/invoice\.stripe\.com\/i\/1/);

    const send = hook(s);
    await s.db.sql`update invoices set stripe_invoice_id = 'in_live_1' where quote_id = ${q.value.id}::bigint`;
    await send("invoice.paid", stripeInvoice("paid"));
    const after = await quoteById(s.db, q.value.id);
    assert.deepEqual([after!.status, after!.decided_by], ["accepted", "paid online"]);
  }));

test("a quote with a Pay button out no longer changes; declining it voids the button; it is not owed until accepted", (t) =>
  withDb(t, async (s) => {
    const { createQuote, saveQuote, decideQuote } = await import("../quotes");
    const { payLinkForQuote, closePayLink } = await import("../stripe");
    const { owed, invoicesFor } = await import("../invoices");
    const q = await createQuote(s.db, { email: "ann@example.com", currency: "usd", lines: [{ description: "Fence", quantity: "1", unit: "100.00" }] }, BY, "crm");
    assert.ok(q.ok);
    const f = fakeStripe({ livemode: true });
    assert.ok((await payLinkForQuote(s.db, f.stripe, q.value.id, BY, "crm")).ok);
    const edit = await saveQuote(s.db, q.value.id, { email: "ann@example.com", currency: "usd", lines: [{ description: "Fence", quantity: "1", unit: "1.00" }] }, BY);
    assert.ok(!edit.ok && /Pay button out/.test(edit.errors.status));
    assert.deepEqual(await owed(s.db, "ann@example.com"), [], "not owed before the yes");
    await decideQuote(s.db, q.value.id, "declined", BY);
    assert.equal(await closePayLink(s.db, () => f.stripe, q.value.id, BY), "Its Pay button is voided in Stripe.");
    assert.ok(f.calls.some((c) => c.path === "/v1/invoices/in_1/void"));
    // The void arrives by the webhook; nothing open is left to void after it.
    await s.db.sql`update invoices set status = 'void'`;
    assert.equal(await closePayLink(s.db, () => { throw new Error("no Stripe needed"); }, q.value.id, BY), null);
    assert.equal((await invoicesFor(s.db, { quoteId: q.value.id }))[0].status, "void");
  }));

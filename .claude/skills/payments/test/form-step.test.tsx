import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { applySchema } from "../../data/migrate";
import { makeStamp } from "../../data/spam";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import type { Field } from "../../forms/fields";
import { embedForm, formRoutes } from "../../forms/routes";
import { seedForm } from "../../forms/store";
import { formsAdmin } from "../../forms/admin";
import { startCheckout } from "../checkout";
import { paymentStep } from "../form-step";
import { StripeError, type Stripe } from "../stripe";
import { createTaxRate } from "../tax";
import { stripeWebhook } from "../webhook";

const schemas = ["../schema.sql", "../../forms/schema.sql"].map((p) => readFileSync(new URL(p, import.meta.url), "utf8"));
const SECRET = "whsec_form_step";
const HOST = "https://bakery.example";

const ORDER: Field[] = [
  { name: "name", label: "Name", type: "text", required: true },
  { name: "email", label: "Email", type: "email", required: true },
  { name: "cookies", label: "Cookies", type: "items", currency: "usd", required: true, items: [
    { key: "choc-chip", label: "Chocolate chip", unit: "dozen", price_cents: 4000 },
    { key: "pb", label: "Peanut butter", unit: "dozen", price_cents: 3600 },
  ] },
  { name: "how", label: "Pickup or delivery", type: "radio", options: ["Pickup", "Delivery"], required: true },
  { name: "address", label: "Address", type: "textarea" },
];

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

function fakeStripe() {
  const calls: { path: string; params: any; key?: string }[] = [];
  let n = 0;
  let down = false;
  const stripe: Stripe = async (method, path, params, o) => {
    calls.push({ path, params, key: o?.idempotencyKey });
    if (down) throw new StripeError("Stripe is down", 500);
    if (path === "/v1/balance") return { livemode: false } as any;
    if (path === "/v1/tax_rates") return { id: "txr_1" } as any;
    if (path === "/v1/checkout/sessions") return { id: `cs_${++n}`, url: `https://checkout.stripe.example/${n}`, livemode: false } as any;
    if (path.endsWith("/expire")) return { status: "expired" } as any;
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { stripe, calls, setDown: (v: boolean) => (down = v) };
}

function site(s: Scratch, stripe: Stripe) {
  const app = new Hono();
  const page = (_c: unknown, title: string, body: unknown) => `<!doctype html><title>${title}</title>${String(body)}`;
  app.route("/", formRoutes(() => s.db, { source: "website", page, steps: { payment: paymentStep(() => s.db, () => stripe, { source: "website" }) } }));
  app.route("/", stripeWebhook(() => s.db, { secret: () => SECRET }));
  app.get("/order", async (c) => c.html(String(await embedForm(c, s.db, "order"))));
  app.route("/admin/forms", formsAdmin(() => s.db, { base: "/admin/forms", css: "/x.css", timeZone: "UTC", source: "website", links: { payment: (id) => `/admin/payments/${id}` } }));
  return app;
}
const send = (app: Hono, path: string, fields: Record<string, string>) =>
  app.request(HOST + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "bakery.example" }, body: new URLSearchParams(fields).toString() });
function event(app: Hono, type: string, object: object) {
  const body = JSON.stringify({ id: `evt_${Math.random()}`, type, created: Math.floor(Date.now() / 1000), data: { object } });
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return app.request(HOST + "/hooks/stripe", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${v1}` }, body });
}

test("an order: two kinds of cookies and delivery, taxed, paid through Checkout and marked paid by the webhook", (t) =>
  withDb(t, async (s) => {
    const rate = await createTaxRate(s.db, { name: "Sales tax", percent: "8.25" }, "owner@example.com");
    assert.ok(rate.ok);
    await seedForm(s.db, { key: "order", title: "Cookie order", fields: [
      ...ORDER,
      { name: "pay", label: "Pay", type: "payment", fees: [{ label: "Delivery", price_cents: 1000, when: { field: "how", is: "Delivery" } }], tax_rate_id: rate.value.id },
    ] }, "website");
    const f = fakeStripe();
    const app = site(s, f.stripe);

    assert.match(await (await app.request(HOST + "/order")).text(), /Step 1 of 2/);
    let res = await send(app, "/forms/order", {
      name: "Ann Lee", email: "ann@example.com", "cookies[choc-chip]": "2", "cookies[pb]": "1", how: "Delivery", address: "1 Elm St",
      company_website: "", _started: await makeStamp("order", undefined, Date.now() - 10_000),
    });
    const next = res.headers.get("location")!;
    const key = new URL(next, HOST).searchParams.get("k")!;
    const [sub] = await s.db.sql`select id::text as id, data from submissions`;
    assert.deepEqual(sub.data.cookies, { "choc-chip": 2, pb: 1 });

    // The payment step shows the lines and total before tax.
    let html = await (await app.request(HOST + next)).text();
    assert.match(html, /2 x Chocolate chip, a dozen/);
    assert.match(html, /\$126\.00/);
    assert.match(html, /Tax is added on the next page/);

    // Stripe down: nothing charged, the step again with a plain message.
    f.setDown(true);
    res = await send(app, "/forms/order", { _draft: key });
    assert.equal(res.status, 422);
    assert.match(await res.text(), /Payment could not start just now/);
    f.setDown(false);

    // Pay: one line per thing, the delivery fee, the tax rate made in Stripe once, back to thanks with paid=1.
    res = await send(app, "/forms/order", { _draft: key });
    assert.equal(res.headers.get("location"), "https://checkout.stripe.example/1");
    const session = f.calls.filter((c) => c.path === "/v1/checkout/sessions").at(-1)!.params;
    const firstSession = session;
    assert.deepEqual(session.line_items.map((l: any) => [l.quantity, l.price_data.unit_amount, l.price_data.product_data.name, l.tax_rates]), [
      [2, 4000, "Chocolate chip, a dozen", ["txr_1"]],
      [1, 3600, "Peanut butter, a dozen", ["txr_1"]],
      [1, 1000, "Delivery", ["txr_1"]],
    ]);
    assert.equal(session.success_url, `${HOST}/forms/order/thanks?paid=1`);
    assert.equal(session.cancel_url, `${HOST}/forms/order/next?k=${encodeURIComponent(key)}`);
    assert.equal(session.metadata.ref_type, "submission");
    assert.equal(session.metadata.ref_id, sub.id);
    assert.equal(session.customer_email, "ann@example.com");

    // A second click: the first checkout is closed before a new one opens, so only one can be paid.
    res = await send(app, "/forms/order", { _draft: key });
    assert.equal(res.headers.get("location"), "https://checkout.stripe.example/2");
    assert.deepEqual(f.calls.filter((c) => c.path.endsWith("/expire")).map((c) => c.path), ["/v1/checkout/sessions/cs_1/expire"]);

    // Cancelled: back on the step, which can be paid again (a new session).
    html = await (await app.request(session.cancel_url)).text();
    assert.match(html, /Pay securely with Stripe/);
    const [pay] = await s.db.sql`select id::text as id, amount_cents::text as amount, status from payments where ref_type = 'submission' and ref_id = ${sub.id} order by id desc`;
    assert.deepEqual([pay.amount, pay.status], ["12600", "pending"]);

    // The webhook: paid, with the total tax included.
    res = await event(app, "checkout.session.completed", {
      id: "cs_2", object: "checkout.session", payment_status: "paid", payment_intent: "pi_1", amount_subtotal: 12600, amount_total: 13640, currency: "usd",
      customer_details: { email: "ann@example.com" }, metadata: session.metadata,
    });
    assert.equal(res.status, 200);
    const [after] = await s.db.sql`select status, total_cents::text as total from payments where id = ${pay.id}::bigint`;
    assert.deepEqual([after.status, after.total], ["paid", "13640"]);
    html = await (await app.request(session.cancel_url)).text();
    assert.match(html, /Paid \$136\.40\. Thank you\./);
    res = await send(app, "/forms/order", { _draft: key });
    assert.equal(res.headers.get("location"), `${HOST}/forms/order/thanks`, "paid: no second checkout");
    assert.match(await (await app.request(HOST + "/forms/order/thanks?paid=1")).text(), /being confirmed/);

    // The team sees the order with its payment, on the list and its page.
    const team = { headers: { "x-tasktool-user": "owner@example.com", host: "bakery.example" } };
    html = await (await app.request(HOST + "/admin/forms/submissions?form=order", team)).text();
    assert.match(html, /Paid \$136\.40 \(test\)/);
    html = await (await app.request(HOST + `/admin/forms/submissions/${sub.id}`, team)).text();
    assert.match(html, /2 x Chocolate chip, a dozen/);
    assert.match(html, /\$126\.00/);
    assert.match(html, new RegExp(`href="/admin/payments/${pay.id}"`));
  }));

test("a form with nothing to pay carries on without Stripe", (t) =>
  withDb(t, async (s) => {
    await seedForm(s.db, { key: "order", title: "Order", fields: [...ORDER.map((f) => (f.type === "items" ? { ...f, required: false } : f)), { name: "pay", label: "Pay", type: "payment" }] }, "website");
    const f = fakeStripe();
    const app = site(s, f.stripe);
    let res = await send(app, "/forms/order", { name: "Bo", email: "bo@example.com", how: "Pickup", company_website: "", _started: await makeStamp("order", undefined, Date.now() - 10_000) });
    const key = new URL(res.headers.get("location")!, HOST).searchParams.get("k")!;
    assert.match(await (await app.request(HOST + res.headers.get("location"))).text(), /nothing to pay/);
    res = await send(app, "/forms/order", { _draft: key });
    assert.equal(res.headers.get("location"), `${HOST}/forms/order/thanks`);
    assert.equal(f.calls.length, 0);
  }));

test("startCheckout refuses lines that do not make the amount", (t) =>
  withDb(t, async (s) => {
    const f = fakeStripe();
    await assert.rejects(startCheckout(s.db, f.stripe, {
      kind: "full", refType: "submission", refId: "1", amountCents: 5000, currency: "usd", description: "x", source: "t",
      successUrl: HOST, cancelUrl: HOST, lines: [{ name: "a", quantity: 2, unitCents: 2000 }],
    }), /together they make amountCents/);
    assert.equal(f.calls.length, 0);
  }));

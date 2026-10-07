import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { applySchema } from "../../data/migrate";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import { stripeWebhook, type WebhookOptions } from "../webhook";
import { startCheckout } from "../checkout";
import { paymentsAdmin } from "../admin";
import { stripeFrom, type Stripe } from "../stripe";

const SECRET = "whsec_payments_test";
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

let s: Scratch | null = null;
before(async () => {
  s = await scratch();
  if (s) {
    await applySchema(s.db, schema);
    await applySchema(s.db, schema); // every start runs it again
  }
});
after(async () => {
  await s?.drop();
});

const noStripe: Stripe = async () => {
  throw new Error("Stripe must not be called");
};

function hook(afterPaid?: WebhookOptions["afterPaid"]) {
  const app = new Hono();
  app.route("/", stripeWebhook(() => s!.db, { secret: () => SECRET, afterPaid }));
  return app;
}

let n = 0;
function send(type: string, object: object, opts: { id?: string; secret?: string; afterPaid?: WebhookOptions["afterPaid"] } = {}) {
  const event = { id: opts.id ?? `evt_${++n}_${Date.now()}`, type, created: Math.floor(Date.now() / 1000), data: { object } };
  const body = JSON.stringify(event);
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = createHmac("sha256", opts.secret ?? SECRET).update(`${t}.${body}`).digest("hex");
  return hook(opts.afterPaid).request("https://hooks.example/hooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": `t=${t},v1=${v1}`, "content-type": "application/json" },
    body,
  });
}

async function pending(ref: string, amount = 5000) {
  const [r] = await s!.db.sql<{ id: string }>`
    insert into payments (amount_cents, currency, kind, ref_type, ref_id, stripe_checkout_session_id, source)
    values (${amount}, 'usd', 'deposit', 'booking', ${ref}, ${"cs_" + ref}, 'test') returning id`;
  return r.id;
}
const row = async (id: string) => (await s!.db.sql`select * from payments where id = ${id}`)[0];
const session = (id: string, ref: string, extra: object = {}) => ({
  id: "cs_" + ref,
  object: "checkout.session",
  client_reference_id: id,
  payment_intent: "pi_" + ref,
  payment_status: "paid",
  amount_subtotal: 5000,
  currency: "usd",
  customer_details: { email: "Payer@Example.com" },
  metadata: { payment_id: id, ref_type: "booking", ref_id: ref },
  ...extra,
});
const charge = (id: string, ref: string, refunded: number, full: boolean) => ({
  id: "ch_" + ref,
  object: "charge",
  payment_intent: "pi_" + ref,
  amount_refunded: refunded,
  refunded: full,
  metadata: { payment_id: id, ref_type: "booking", ref_id: ref },
});

test("a completed checkout marks the payment paid, from the webhook alone", async (t) => {
  if (!s) return t.skip(why);
  const id = await pending("b1");
  const res = await send("checkout.session.completed", session(id, "b1"));
  assert.equal(res.status, 200);
  const p = await row(id);
  assert.equal(p.status, "paid");
  assert.equal(p.stripe_payment_intent_id, "pi_b1");
  assert.equal(p.email, "payer@example.com");
  assert.ok(p.paid_at);
});

test("afterPaid runs for an event that leaves the payment paid, and again on the retry after it failed", async (t) => {
  if (!s) return t.skip(why);
  const id = await pending("b9");
  const calls: string[] = [];
  let fail = true;
  const afterPaid = async (_c: unknown, paymentId: string) => {
    calls.push(paymentId);
    if (fail) throw new Error("down");
  };
  const expired = await send("checkout.session.expired", session(await pending("b10"), "b10"), { afterPaid });
  assert.equal(expired.status, 200);
  assert.deepEqual(calls, [], "not for an event that leaves it unpaid");
  const first = await send("checkout.session.completed", session(id, "b9"), { id: "evt_after", afterPaid });
  assert.equal(first.status, 500, "a failure is a 500, so Stripe delivers again");
  fail = false;
  const again = await send("checkout.session.completed", session(id, "b9"), { id: "evt_after", afterPaid });
  assert.equal(again.status, 200);
  assert.deepEqual(calls, [String(id), String(id)], "the retry ran it again from the recorded row");
  assert.equal((await row(id)).status, "paid");
  // Refunded whole, its paid event never seen: not bought, so nothing follows.
  await send("charge.refunded", charge(await pending("b11"), "b11", 5000, true), { afterPaid });
  assert.equal(calls.length, 2, "not for a payment refunded whole");
});

test("the same event delivered twice is handled once", async (t) => {
  if (!s) return t.skip(why);
  const id = await pending("b2");
  const first = await send("charge.refunded", charge(id, "b2", 1000, false), { id: "evt_dup" });
  assert.equal(first.status, 200);
  await s.db.sql`update payments set refunded_cents = 0, status = 'paid' where id = ${id}`; // pretend we never saw it
  const again = await send("charge.refunded", charge(id, "b2", 1000, false), { id: "evt_dup" });
  assert.equal(again.status, 200);
  const p = await row(id);
  assert.equal(p.status, "paid", "the redelivery changed nothing");
  const [{ c }] = await s.db.sql`select count(*)::int as c from stripe_events where id = 'evt_dup'`;
  assert.equal(c, 1);
});

test("a refund then a late completed event does not go back to paid", async (t) => {
  if (!s) return t.skip(why);
  const id = await pending("b3");
  // The refund arrives first: the row is still pending and has no payment intent yet.
  await send("charge.refunded", charge(id, "b3", 5000, true));
  let p = await row(id);
  assert.equal(p.status, "refunded");
  assert.equal(Number(p.refunded_cents), 5000);
  assert.equal(p.stripe_payment_intent_id, "pi_b3", "found by its metadata, then linked");
  assert.ok(p.paid_at, "a refund proves the money was taken, even before the payment event");

  await send("checkout.session.completed", session(id, "b3"));
  p = await row(id);
  assert.equal(p.status, "refunded");
  assert.ok(p.paid_at, "the late completed event still fills when it was paid");
  assert.equal(p.email, "payer@example.com");
});

test("partial refunds only rise, and a stale one is ignored", async (t) => {
  if (!s) return t.skip(why);
  const id = await pending("b4");
  await send("checkout.session.completed", session(id, "b4"));
  await send("charge.refunded", charge(id, "b4", 2000, false));
  await send("charge.refunded", charge(id, "b4", 1000, false)); // older, arriving late
  let p = await row(id);
  assert.equal(p.status, "partially_refunded");
  assert.equal(Number(p.refunded_cents), 2000);
  await send("charge.refunded", charge(id, "b4", 5000, true));
  p = await row(id);
  assert.equal(p.status, "refunded");
});

test("a declined card then a paid session ends paid; an expiry after payment changes nothing", async (t) => {
  if (!s) return t.skip(why);
  const id = await pending("b5");
  await send("payment_intent.payment_failed", { id: "pi_b5", object: "payment_intent", metadata: { payment_id: id, ref_type: "booking", ref_id: "b5" } });
  assert.equal((await row(id)).status, "failed");
  await send("checkout.session.completed", session(id, "b5"));
  assert.equal((await row(id)).status, "paid");
  await send("checkout.session.expired", session(id, "b5", { payment_status: "unpaid" }));
  assert.equal((await row(id)).status, "paid");

  const id2 = await pending("b6");
  await send("checkout.session.expired", session(id2, "b6", { payment_status: "unpaid", payment_intent: null }));
  assert.equal((await row(id2)).status, "cancelled");
});

test("an event from another integration on the same Stripe account touches nothing", async (t) => {
  if (!s) return t.skip(why);
  const id = await pending("b7");
  // Same numeric client_reference_id, but not our session and not our refs.
  await send("checkout.session.completed", { ...session(id, "b7"), id: "cs_other", payment_intent: "pi_other", metadata: {} });
  assert.equal((await row(id)).status, "pending");
});

test("a bad signature is 400 and records nothing; an unhandled type is 200", async (t) => {
  if (!s) return t.skip(why);
  const id = await pending("b8");
  const bad = await send("checkout.session.completed", session(id, "b8"), { id: "evt_forged", secret: "whsec_wrong" });
  assert.equal(bad.status, 400);
  assert.equal((await row(id)).status, "pending");
  assert.equal((await s.db.sql`select 1 from stripe_events where id = 'evt_forged'`).length, 0);
  const unsigned = await hook().request("https://hooks.example/hooks/stripe", { method: "POST", body: "{}" });
  assert.equal(unsigned.status, 400);
  assert.equal((await send("customer.created", { id: "cus_1" })).status, 200);
});

test("checkout records the payment first, stores the session, and sends an idempotency key", async (t) => {
  if (!s) return t.skip(why);
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json({ id: "cs_new", url: "https://checkout.stripe.com/c/pay/cs_new", livemode: false });
  }) as unknown as typeof fetch;
  const stripe = stripeFrom({ PHOENIX_URL: "https://tt.example", MACHINE_TOKEN: "mt" }, fakeFetch);

  const out = await startCheckout(s.db, stripe, {
    kind: "deposit", refType: "booking", refId: "99", amountCents: 2500, currency: "USD",
    description: "Deposit", email: " Ann@Example.com ", source: "booking",
    successUrl: "https://site.example/thanks", cancelUrl: "https://site.example/book",
  });
  assert.equal(out.url, "https://checkout.stripe.com/c/pay/cs_new");
  assert.equal(calls[0].url, "https://tt.example/api/machine/gateway/stripe/v1/checkout/sessions");
  const headers = Object.fromEntries(new Headers(calls[0].init.headers));
  const [{ match_key }] = await s.db.sql`select match_key from payments where id = ${out.paymentId}`;
  assert.match(match_key, /^[0-9a-f-]{36}$/);
  assert.equal(headers["idempotency-key"], `checkout-${match_key}`, "per row and unique across projects sharing a Stripe account");
  const form = new URLSearchParams(String(calls[0].init.body));
  assert.equal(form.get("client_reference_id"), out.paymentId);
  assert.equal(form.get("metadata[payment_id]"), out.paymentId);
  assert.equal(form.get("metadata[payment_key]"), match_key);
  assert.equal(form.get("payment_intent_data[metadata][payment_key]"), match_key);
  assert.equal(form.get("payment_intent_data[metadata][ref_id]"), "99");
  assert.equal(form.get("line_items[0][price_data][unit_amount]"), "2500");
  assert.equal(form.get("line_items[0][price_data][currency]"), "usd");
  assert.equal(form.get("customer_email"), "ann@example.com");

  const p = await row(out.paymentId);
  assert.equal(p.status, "pending");
  assert.equal(p.stripe_checkout_session_id, "cs_new");
  assert.equal(p.livemode, false);
});

test("a checkout Stripe refuses leaves its row cancelled, not pending", async (t) => {
  if (!s) return t.skip(why);
  const fakeFetch = (async () => Response.json({ error: { message: "Amount too small" } }, { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(
    startCheckout(s.db, stripeFrom({ STRIPE_API_KEY: "sk_test" }, fakeFetch), {
      kind: "full", refType: "invoice", refId: "inv-1", amountCents: 10, currency: "usd", description: "x",
      source: "t", successUrl: "https://s/ok", cancelUrl: "https://s/no",
    }),
    /Amount too small/,
  );
  const [p] = await s.db.sql`select status from payments where ref_id = 'inv-1'`;
  assert.equal(p.status, "cancelled");
});

test("a payment with the same id in another project on the same Stripe account touches nothing", async (t) => {
  if (!s) return t.skip(why);
  // Ours: paid, linked to pi_x1.
  const id = await pending("x1");
  await send("checkout.session.completed", session(id, "x1"));
  // Theirs: same payment id and refs (both databases count from 1), its own intent, refunded in full.
  await send("charge.refunded", { ...charge(id, "x1", 5000, true), id: "ch_theirs", payment_intent: "pi_theirs" });
  let p = await row(id);
  assert.equal(p.status, "paid");
  assert.equal(Number(p.refunded_cents), 0);

  // A pending row of ours with a payment_key: their decline carries their key, or none.
  const [mine] = await s.db.sql<{ id: string }>`
    insert into payments (amount_cents, currency, ref_type, ref_id, match_key)
    values (5000, 'usd', 'booking', 'x2', 'key-ours') returning id::text as id`;
  const declined = (key?: string) => ({
    id: "pi_theirs_" + (key ?? "none"),
    object: "payment_intent",
    metadata: { payment_id: mine.id, ref_type: "booking", ref_id: "x2", ...(key ? { payment_key: key } : {}) },
  });
  await send("payment_intent.payment_failed", declined("key-theirs"));
  await send("payment_intent.payment_failed", declined());
  p = await row(mine.id);
  assert.equal(p.status, "pending");
  assert.equal(p.stripe_payment_intent_id, null);
  await send("payment_intent.payment_failed", { ...declined("key-ours"), id: "pi_x2" });
  assert.equal((await row(mine.id)).status, "failed", "our own key still matches before the ids are linked");
});

test("a Payment Link session naming our row in client_reference_id touches nothing", async (t) => {
  if (!s) return t.skip(why);
  // A row with no refs, and an owner's Payment Link opened with ?client_reference_id=<its id>.
  const [r] = await s.db.sql<{ id: string }>`
    insert into payments (amount_cents, currency) values (50000, 'usd') returning id::text as id`;
  await send("checkout.session.completed", {
    id: "cs_link", object: "checkout.session", client_reference_id: r.id, payment_intent: "pi_link",
    payment_status: "paid", amount_subtotal: 100, currency: "usd", metadata: {},
  });
  assert.equal((await row(r.id)).status, "pending");
});

test("a paid session for a different amount or currency does not mark the row paid", async (t) => {
  if (!s) return t.skip(why);
  const id = await pending("m1");
  await send("checkout.session.completed", session(id, "m1", { amount_subtotal: 100 }));
  let p = await row(id);
  assert.equal(p.status, "pending");
  assert.equal(p.paid_at, null);
  const id2 = await pending("m2");
  await send("checkout.session.completed", session(id2, "m2", { currency: "eur" }));
  assert.equal((await row(id2)).status, "pending");
  // Tax or a discount changes the total, not the subtotal.
  const id3 = await pending("m3");
  await send("checkout.session.completed", session(id3, "m3", { amount_total: 5400 }));
  assert.equal((await row(id3)).status, "paid");
});

test("an event matching one row by id is not applied to another row by its metadata", async (t) => {
  if (!s) return t.skip(why);
  const a = await pending("o1");
  const b = await pending("o2");
  // Session of o1, but metadata naming o2 (refs and id): the Stripe id wins.
  await send("checkout.session.completed", session(a, "o1", { metadata: { payment_id: b, ref_type: "booking", ref_id: "o2" } }));
  assert.equal((await row(a)).status, "paid");
  assert.equal((await row(b)).status, "pending");
});

test("a refund with no payment event takes paid_at from the charge, and keeps an earlier one", async (t) => {
  if (!s) return t.skip(why);
  const id = await pending("pa1");
  await send("charge.refunded", { ...charge(id, "pa1", 1000, false), created: 1_790_000_000 });
  let p = await row(id);
  assert.equal(p.status, "partially_refunded");
  assert.equal(new Date(p.paid_at).getTime(), 1_790_000_000_000);
  await send("charge.refunded", { ...charge(id, "pa1", 5000, true), created: 1_790_009_999 });
  p = await row(id);
  assert.equal(new Date(p.paid_at).getTime(), 1_790_000_000_000, "only fills a blank");

  const id2 = await pending("pa2");
  await send("charge.refunded", charge(id2, "pa2", 5000, true)); // no created: now()
  assert.ok((await row(id2)).paid_at);
});

// ── Admin ────────────────────────────────────────────────────────────────────

const admin = (stripe: Stripe = noStripe) => {
  const app = new Hono();
  app.route("/admin/payments", paymentsAdmin(() => s!.db, { stripe: () => stripe, base: "/admin/payments", css: "/site.css", timeZone: "America/Chicago" }));
  return app;
};
const team = { "x-tasktool-user": "owner@example.com", host: "site.example", origin: "https://site.example" };

test("the payments list is a 404 without a signed-in team member", async () => {
  const res = await admin().request("https://site.example/admin/payments");
  assert.equal(res.status, 404);
  assert.equal((await admin().request("https://site.example/admin/payments/export.csv")).status, 404);
});

test("the list filters and searches; the export is CSV", async (t) => {
  if (!s) return t.skip(why);
  const id = await pending("list1");
  await s.db.sql`update payments set email = 'zed@example.com' where id = ${id}`;
  const res = await admin().request("https://site.example/admin/payments?q=ZED&kind=deposit", { headers: team });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /zed@example\.com/);
  assert.match(html, /\$50\.00/);
  const none = await (await admin().request("https://site.example/admin/payments?q=%25", { headers: team })).text();
  assert.doesNotMatch(none, /zed@example\.com/, "a % in the search is a character, not a wildcard");

  const csv = await (await admin().request("https://site.example/admin/payments/export.csv?q=zed", { headers: team })).text();
  assert.match(csv, /zed@example\.com/);
  assert.match(csv, /50\.00/);
});

test("a refund needs a confirmation, sends an idempotency key, and leaves the status to the webhook", async (t) => {
  if (!s) return t.skip(why);
  const id = await pending("r1");
  await send("checkout.session.completed", session(id, "r1"));
  const sent: { params: unknown; key?: string }[] = [];
  const stripe: Stripe = async (_m, _p, params, opts) => {
    sent.push({ params, key: opts?.idempotencyKey });
    return { id: "re_1" } as any;
  };

  const confirm = await admin(stripe).request(`https://site.example/admin/payments/${id}/refund`, { headers: team });
  assert.equal(confirm.status, 200);
  assert.match(await confirm.text(), /cannot be undone/);
  assert.equal(sent.length, 0, "opening the confirmation moves no money");

  const post = (amount: string, seen = "0") =>
    admin(stripe).request(`https://site.example/admin/payments/${id}/refund`, {
      method: "POST",
      headers: { ...team, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ amount, seen }).toString(),
    });
  assert.match(await (await post("60.00")).text(), /At most \$50\.00/);
  const ok = await post("20.00");
  assert.equal(ok.status, 303);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, `refund-pi_r1-0-2000`);
  assert.deepEqual((sent[0].params as any).amount, 2000);
  assert.equal((await row(id)).status, "paid");
  assert.equal((await row(id)).updated_by, "owner@example.com");

  const stale = await post("10.00", "999");
  assert.match(await stale.text(), /since this page opened/);
  assert.equal(sent.length, 1);

  const crossSite = await admin(stripe).request(`https://site.example/admin/payments/${id}/refund`, {
    method: "POST",
    headers: { ...team, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
    body: "amount=1&seen=0",
  });
  assert.equal(crossSite.status, 403);
});

test("with no secret option the webhook reads STRIPE_WEBHOOK_SECRET as a setting", async () => {
  const app = new Hono();
  app.route("/", stripeWebhook(() => {
    throw new Error("an unhandled event never reaches the database");
  }));
  const body = JSON.stringify({ id: "evt_setting", type: "customer.created", data: { object: {} } });
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  const req = () => new Request("https://hooks.example/hooks/stripe", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${v1}` }, body });
  assert.equal((await app.request(req(), undefined, { STRIPE_WEBHOOK_SECRET: SECRET })).status, 200);
  // On the machine c.env is node-server's { incoming, outgoing }: the process env is read instead.
  const saved = process.env.STRIPE_WEBHOOK_SECRET;
  try {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    assert.equal((await app.request(req(), undefined, { incoming: {}, outgoing: {} })).status, 200);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    assert.equal((await app.request(req(), undefined, { incoming: {}, outgoing: {} })).status, 500, "not configured");
  } finally {
    if (saved === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = saved;
  }
});

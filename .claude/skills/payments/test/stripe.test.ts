import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { formEncode, stripeFrom, StripeError } from "../stripe";
import { verifyStripeSignature } from "../webhook";
import { decimals, formatMoney, toMinor } from "../money";

// ── Signature ────────────────────────────────────────────────────────────────

const SECRET = "whsec_test_secret";
const BODY = '{"id":"evt_1","type":"checkout.session.completed","data":{"object":{"name":"Zoë"}}}';
const NOW = 1_790_000_000_000;
const T = String(NOW / 1000);
const sign = (t: string, body: string, secret = SECRET) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

test("a fixed vector: Stripe's scheme, HMAC-SHA256 of `${t}.${body}`, verifies", async () => {
  // Computed once with `printf '%s' '1790000000.{"a":1}' | openssl dgst -sha256 -hmac whsec_test_secret`.
  const v1 = "9d6a5e24fae7ac6231e97882d9e3c3730db3928cd01494f2394ec6ab0c349fa8";
  assert.equal(await verifyStripeSignature('{"a":1}', `t=1790000000,v1=${v1}`, SECRET, { now: NOW }), true);
});

test("a valid signature over the raw bytes verifies", async () => {
  const header = `t=${T},v1=${sign(T, BODY)}`;
  assert.equal(await verifyStripeSignature(new TextEncoder().encode(BODY), header, SECRET, { now: NOW }), true);
  assert.equal(await verifyStripeSignature(BODY, header, SECRET, { now: NOW }), true);
});

test("a tampered body fails", async () => {
  const header = `t=${T},v1=${sign(T, BODY)}`;
  assert.equal(await verifyStripeSignature(BODY.replace("Zoë", "Zoe"), header, SECRET, { now: NOW }), false);
  // Re-serialised JSON is a different body: always verify the bytes Stripe sent.
  assert.equal(await verifyStripeSignature(JSON.stringify(JSON.parse(BODY), null, 1), header, SECRET, { now: NOW }), false);
});

test("an old timestamp fails even with a good signature", async () => {
  const old = String(NOW / 1000 - 301);
  assert.equal(await verifyStripeSignature(BODY, `t=${old},v1=${sign(old, BODY)}`, SECRET, { now: NOW }), false);
  const recent = String(NOW / 1000 - 299);
  assert.equal(await verifyStripeSignature(BODY, `t=${recent},v1=${sign(recent, BODY)}`, SECRET, { now: NOW }), true);
});

test("any one of several v1 values may match (a secret being rolled)", async () => {
  const header = `t=${T},v1=${sign(T, BODY, "whsec_old")},v0=deadbeef,v1=${sign(T, BODY)}`;
  assert.equal(await verifyStripeSignature(BODY, header, SECRET, { now: NOW }), true);
});

test("an empty secret fails rather than throwing", async () => {
  assert.equal(await verifyStripeSignature(BODY, `t=${T},v1=${sign(T, BODY, "")}`, "", { now: NOW }), false);
});

test("spaces, a part without =, and a future timestamp", async () => {
  assert.equal(await verifyStripeSignature(BODY, ` t=${T} , junk , v1=${sign(T, BODY)} `, SECRET, { now: NOW }), true);
  const ahead = String(NOW / 1000 + 301);
  assert.equal(await verifyStripeSignature(BODY, `t=${ahead},v1=${sign(ahead, BODY)}`, SECRET, { now: NOW }), false);
});

test("the wrong secret, or a malformed header, fails", async () => {
  assert.equal(await verifyStripeSignature(BODY, `t=${T},v1=${sign(T, BODY, "whsec_other")}`, SECRET, { now: NOW }), false);
  for (const h of [null, "", `v1=${sign(T, BODY)}`, `t=${T}`, `t=${T},v1=zz`, `t=abc,v1=${sign(T, BODY)}`]) {
    assert.equal(await verifyStripeSignature(BODY, h, SECRET, { now: NOW }), false, String(h));
  }
});

// ── Form encoding and the caller ─────────────────────────────────────────────

test("nested params become Stripe's bracketed form keys", () => {
  const s = formEncode({
    mode: "payment",
    customer_email: undefined,
    expires_at: null,
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 5000, product_data: { name: "Deposit & fee" } } }],
    metadata: { ref_type: "booking", ref_id: "42" },
    automatic_tax: { enabled: false },
    unset: "",
  });
  assert.equal(
    s,
    "mode=payment&line_items[0][quantity]=1&line_items[0][price_data][currency]=usd&line_items[0][price_data][unit_amount]=5000" +
      "&line_items[0][price_data][product_data][name]=Deposit+%26+fee&metadata[ref_type]=booking&metadata[ref_id]=42" +
      "&automatic_tax[enabled]=false&unset=",
  );
});

type Call = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("with a bound key the call goes to Stripe; without one, through the gateway", async () => {
  const direct = fakeFetch(200, { id: "cs_1" });
  await stripeFrom({ STRIPE_API_KEY: "sk_test_x" }, direct.f)("POST", "/v1/checkout/sessions", { mode: "payment" }, { idempotencyKey: "k1" });
  assert.equal(direct.calls[0].url, "https://api.stripe.com/v1/checkout/sessions");
  const h = direct.calls[0].init.headers as Record<string, string>;
  assert.equal(h.Authorization, "Bearer sk_test_x");
  assert.equal(h["Idempotency-Key"], "k1");
  assert.equal(h["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(direct.calls[0].init.body, "mode=payment");

  const gw = fakeFetch(200, { data: [] });
  await stripeFrom({ PHOENIX_URL: "https://tt.example/", MACHINE_TOKEN: "mt" }, gw.f)("GET", "/v1/refunds", { limit: 3 });
  assert.equal(gw.calls[0].url, "https://tt.example/api/sprite/gateway/stripe/v1/refunds?limit=3");
  assert.equal(new Headers(gw.calls[0].init.headers).get("authorization"), "Bearer mt");

  // A connection whose slug is not "stripe" has its own key name.
  const other = fakeFetch(200, { data: [] });
  await stripeFrom({ STRIPE_API_KEY: "wrong", STRIPE_EU_API_KEY: "sk_eu" }, other.f, "stripe-eu")("GET", "/v1/refunds");
  assert.equal((other.calls[0].init.headers as Record<string, string>).Authorization, "Bearer sk_eu");

  assert.throws(() => stripeFrom({}), /request_connection/);
});

test("a POST without an idempotency key is refused before it is sent", async () => {
  const { f, calls } = fakeFetch(200, {});
  await assert.rejects(stripeFrom({ STRIPE_API_KEY: "k" }, f)("POST", "/v1/refunds", {}), /idempotencyKey/);
  assert.equal(calls.length, 0);
});

test("Stripe's error and the platform's refusal come back typed", async () => {
  const e1 = fakeFetch(402, { error: { type: "card_error", code: "card_declined", message: "Your card was declined." } });
  await assert.rejects(stripeFrom({ STRIPE_API_KEY: "k" }, e1.f)("GET", "/v1/x"), (e: unknown) => {
    assert.ok(e instanceof StripeError);
    assert.equal(e.status, 402);
    assert.equal(e.code, "card_declined");
    assert.equal(e.message, "Your card was declined.");
    return true;
  });
  const e2 = fakeFetch(404, { error: "unknown_connection" }, { "x-tasktool-refusal": "unknown_connection" });
  await assert.rejects(stripeFrom({ PHOENIX_URL: "https://tt", MACHINE_TOKEN: "m" }, e2.f)("GET", "/v1/x"), (e: unknown) => {
    assert.ok(e instanceof StripeError);
    assert.equal(e.refusal, "unknown_connection");
    return true;
  });
});

// ── Money ────────────────────────────────────────────────────────────────────

test("minor units follow the currency, not a fixed 100", () => {
  assert.equal(toMinor("12.5", "usd"), 1250);
  assert.equal(toMinor("1,200", "jpy"), 1200);
  assert.equal(toMinor("1.5", "jpy"), null);
  assert.equal(toMinor("1.234", "kwd"), 1234);
  assert.equal(toMinor("0.1", "usd"), 10); // never 0.1 * 100 = 10.000000000000002
  assert.equal(toMinor("-1", "usd"), null);
  assert.equal(toMinor("abc", "usd"), null);
  // A decimal comma is refused, never read as thousands: "12,50" is not 1250.00.
  assert.equal(toMinor("12,50", "eur"), null);
  assert.equal(toMinor("1,2", "usd"), null);
  assert.equal(toMinor("1,234,567.89", "usd"), 123456789);
  assert.equal(toMinor("10.005", "usd"), null, "too many decimals is refused, not rounded");
  assert.equal(decimals("HUF"), 2);
  assert.equal(formatMoney(1250, "usd"), "$12.50");
  assert.equal(formatMoney(1200, "jpy"), "¥1,200");
});

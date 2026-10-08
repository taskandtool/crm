// The deposit recipe in SKILL.md, end to end: the booking skill makes the
// booking, afterBook starts Checkout for it, the payer is sent to Stripe, the
// success and cancel URLs are the booking's manage page, and that page shows
// the deposit once the webhook marks it paid. Needs the booking skill beside
// this one; copy this test only with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { applySchema } from "../../data/migrate";
import { makeStamp } from "../../data/spam";
import { scratch, why } from "../../data/test/scratch";
import { addWindow, createPerson, createType, setHosts } from "../../booking/hours";
import { bookingPages } from "../../booking/public";
import { startCheckout } from "../checkout";
import { stripeWebhook } from "../webhook";
import type { Stripe } from "../stripe";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const SECRET = "whsec_deposit";

test("afterBook takes the deposit; the manage page shows it once Stripe says it is paid", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await applySchema(s.db, read("../../booking/schema.sql"));
    await applySchema(s.db, read("../schema.sql"));
    const r = await createPerson(s.db, { name: "Pat", email: "pat@example.com", time_zone: "UTC" }, "owner@example.com", "website");
    assert.ok(r.ok);
    for (let d = 0; d < 7; d++) await addWindow(s.db, r.value.id, String(d), "00:00", "24:00", "owner@example.com");
    const type = await createType(s.db, {
      name: "Intro call", slug: "intro", duration_min: "30", interval_min: "30", buffer_before_min: "0", buffer_after_min: "0",
      min_notice_min: "0", horizon_days: "14", location_kind: "our_place", location: "1 Main St",
    }, "owner@example.com", "website");
    assert.ok(type.ok);
    await setHosts(s.db, type.value.id, [r.value.id]);

    const sessions: URLSearchParams[] = [];
    const stripe: Stripe = async (_method, _path, params) => {
      const { formEncode } = await import("../stripe");
      sessions.push(new URLSearchParams(formEncode(params!)));
      return { id: "cs_dep", url: "https://checkout.stripe.com/c/pay/cs_dep", livemode: false } as any;
    };
    const getDb = () => s.db;
    const app = new Hono();
    // As in SKILL.md, with the test's Stripe in place of stripeFrom(envOf(c)).
    app.route("/book", bookingPages(getDb, {
      base: "/book", domain: "acme.com", css: "/site.css", source: "website",
      afterBook: async (_c, e) => {
        const { url } = await startCheckout(getDb(), stripe, {
          kind: "deposit", refType: "booking", refId: e.booking.id,
          amountCents: 5000, currency: "usd", description: `Deposit: ${e.type.name} with ${e.host.name}`,
          email: e.booking.email, name: e.booking.name, source: "website",
          successUrl: `${e.manageUrl}?new=1`, cancelUrl: `${e.manageUrl}?new=1`,
          expiresAt: new Date(Date.now() + 30 * 60_000),
        });
        return url;
      },
    }));
    app.route("/", stripeWebhook(getDb, { secret: () => SECRET }));

    const html = await (await app.request("/book/intro?tz=UTC")).text();
    const start = new URL(/href="(\/book\/intro\/confirm\?start=[^"]+)"/.exec(html)![1].replace(/&amp;/g, "&"), "http://x").searchParams.get("start")!;
    const _started = await makeStamp("booking:intro", Date.now() - 10_000);
    const res = await app.request("/book/intro", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ start, tz: "UTC", name: "Ann", email: "ann@example.com", _started }),
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "https://checkout.stripe.com/c/pay/cs_dep");

    // Both ways back from Stripe land on a page that exists: the booking's manage page.
    const success = sessions[0].get("success_url")!;
    assert.equal(sessions[0].get("cancel_url"), success);
    assert.match(success, /^http:\/\/localhost\/book\/manage\/[A-Za-z0-9_-]{43}\?new=1$/);
    const manage = new URL(success).pathname + new URL(success).search;
    let page = await (await app.request(manage)).text();
    assert.match(page, /You are booked/);
    assert.match(page, /Deposit not confirmed yet/);

    // Stripe's webhook, not the redirect, marks it paid.
    const [{ id }] = await s.db.sql`select id::text as id from payments`;
    const [{ match_key }] = await s.db.sql`select match_key from payments`;
    const [{ bid }] = await s.db.sql`select id::text as bid from bookings`;
    const body = JSON.stringify({
      id: "evt_dep", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000),
      data: { object: { id: "cs_dep", payment_intent: "pi_dep", payment_status: "paid", amount_subtotal: 5000, currency: "usd", metadata: { payment_id: id, payment_key: match_key, ref_type: "booking", ref_id: bid } } },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const v1 = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
    assert.equal((await app.request("/hooks/stripe", { method: "POST", headers: { "stripe-signature": `t=${ts},v1=${v1}` }, body })).status, 200);
    page = await (await app.request(manage)).text();
    assert.match(page, /Deposit paid\./);
  } finally {
    await s.drop();
  }
});

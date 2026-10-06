import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { applySchema } from "../../data/migrate";
import { makeStamp } from "../../data/spam";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import type { Field } from "../../forms/fields";
import { formRoutes } from "../../forms/routes";
import { completePaidSubmission, seedForm } from "../../forms/store";
import { paymentStep } from "../../payments/form-step";
import type { Stripe } from "../../payments/stripe";
import { releaseLapsedHolds } from "../book";
import { bookingStep } from "../form-step";
import { confirmFormBooking } from "../confirm";
import { emailSender, type Message, type Send } from "../notify";
import { bookingPages } from "../public";
import { addWindow, createPerson, createType, readType, setHosts } from "../hours";

const schemas = ["../schema.sql", "../../payments/schema.sql", "../../forms/schema.sql"].map((p) => readFileSync(new URL(p, import.meta.url), "utf8"));
const HOST = "https://counsel.example";
const BY = "owner@example.com";

const INTAKE: Field[] = [
  { name: "name", label: "Name", type: "text", required: true },
  { name: "email", label: "Email", type: "email", required: true },
  { name: "goal", label: "What brings you here?", type: "textarea", required: true },
  { name: "when", label: "Pick a time", type: "booking", booking_type: "intake" },
  { name: "pay", label: "Pay for the session", type: "payment" },
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

/** Pat, free 09:00 to 17:00 UTC every day, takes a paid 50-minute intake. */
async function intake(s: Scratch, price = "120.00") {
  const p = await createPerson(s.db, { name: "Pat", email: "pat@example.com", time_zone: "UTC" }, BY, "test");
  assert.ok(p.ok);
  for (let d = 0; d < 7; d++) await addWindow(s.db, p.value.id, String(d), "09:00", "17:00", BY);
  const t = await createType(s.db, {
    name: "Intake session", slug: "intake", duration_min: "50", interval_min: "60", buffer_before_min: "0", buffer_after_min: "0",
    min_notice_min: "0", horizon_days: "14", location_kind: "video", location: "https://meet.example/pat", price, currency: "usd",
  }, BY, "test");
  assert.ok(t.ok, JSON.stringify(t));
  await setHosts(s.db, t.value.id, [p.value.id]);
  return t.value;
}

test("a price on a booking type is typed as money and kept in minor units", () => {
  const base = { name: "X", slug: "x", duration_min: "30", interval_min: "30", buffer_before_min: "0", buffer_after_min: "0", min_notice_min: "0", horizon_days: "7", location_kind: "phone" };
  const r = readType({ ...base, price: "$120.50", currency: "USD" });
  assert.ok(r.ok);
  assert.deepEqual([r.value.price_cents, r.value.currency], [12050, "usd"]);
  const free = readType({ ...base, price: "" });
  assert.ok(free.ok && free.value.price_cents === null && free.value.currency === null);
  const bad = readType({ ...base, price: "12,50" });
  assert.ok(!bad.ok && bad.errors.price);
});

test("a paid intake: questions, a time held inside the form, the price charged, then released if never paid", (t) =>
  withDb(t, async (s) => {
    await intake(s);
    await seedForm(s.db, { key: "intake", title: "Intake", fields: INTAKE }, "website");
    const sessions: any[] = [];
    const stripe: Stripe = async (_m, path, params) => {
      if (path === "/v1/checkout/sessions") return (sessions.push(params), { id: `cs_${sessions.length}`, url: "https://checkout.stripe.example/1", livemode: false }) as any;
      throw new Error(path);
    };
    const app = new Hono();
    app.route("/", formRoutes(() => s.db, {
      source: "website", page: (_c, title, body) => `<title>${title}</title>${String(body)}`,
      steps: { booking: bookingStep(() => s.db, { source: "website" }), payment: paymentStep(() => s.db, () => stripe, { source: "website" }) },
    }));
    const send = (fields: Record<string, string>) =>
      app.request(HOST + "/forms/intake", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "counsel.example" }, body: new URLSearchParams(fields).toString() });

    let res = await send({ name: "Ann Lee", email: "ann@example.com", goal: "Sleep better", company_website: "", _started: await makeStamp("intake", undefined, Date.now() - 10_000) });
    const step = res.headers.get("location")!;
    const key = new URL(step, HOST).searchParams.get("k")!;

    // The booking step: the type's days and times inside the form, its price named.
    const html = await (await app.request(HOST + step)).text();
    assert.match(html, /Step 2 of 3/);
    assert.match(html, /Intake session, 50 minutes, \$120\.00/);
    const start = /name="start" value="([^"]+)"/.exec(html)![1];

    res = await send({ _draft: key });
    assert.equal(res.status, 422);
    assert.match(await res.text(), /Pick a time\./);
    // A double click: two posts at once make one booking and one charge.
    const [one, two] = await Promise.all([send({ _draft: key, _step: "1", start }), send({ _draft: key, _step: "1", start })]);
    assert.deepEqual([one.status, two.status], [303, 303]);
    assert.equal((await s.db.sql`select count(*)::int as n from bookings where status = 'confirmed'`)[0].n, 1);

    const [b] = await s.db.sql`select * from bookings`;
    const [sub] = await s.db.sql`select id, data from submissions`;
    assert.equal(String(b.submission_id), String(sub.id), "the booking names the submission");
    assert.equal(b.email, "ann@example.com");
    assert.equal(b.status, "confirmed");
    assert.ok(b.hold_until && new Date(b.hold_until) > new Date(), "held while the payment follows");
    assert.deepEqual(Object.values(sub.data._charges).map((c: any) => [c.unit_cents, c.currency]), [[12000, "usd"]]);

    // Taken: someone else is offered the time no more.
    assert.doesNotMatch(await (await app.request(HOST + step)).text(), new RegExp(`value="${start}"`));

    // The payment step charges the booking's price.
    res = await send({ _draft: key });
    assert.equal(res.headers.get("location"), "https://checkout.stripe.example/1");
    assert.deepEqual(sessions[0].line_items.map((l: any) => [l.quantity, l.price_data.unit_amount]), [[1, 12000]]);
    const complete = async () => (await s.db.sql`select completed_at from submissions`)[0].completed_at !== null;
    assert.equal(await complete(), false, "booked and sent to pay: not complete until Stripe says paid");

    // A checkout just opened keeps the hold past its time; once that is old too and nothing paid, it is released.
    const later = new Date(Date.now() + 50 * 60_000);
    await s.db.sql`update bookings set hold_until = now() - interval '1 minute'`;
    assert.equal(await releaseLapsedHolds(s.db), 0, "past the hold, but its checkout is still open");
    await s.db.sql`update payments set status = 'failed'`;
    assert.equal(await releaseLapsedHolds(s.db, later), 0, "one card declined, the checkout still open: held");
    await s.db.sql`update payments set status = 'cancelled'`; // checkout.session.expired
    assert.equal(await releaseLapsedHolds(s.db, later), 1);
    const [gone] = await s.db.sql`select status, updated_by from bookings`;
    assert.deepEqual([gone.status, gone.updated_by], ["cancelled", "form not finished in time"]);
    assert.equal(await releaseLapsedHolds(s.db, later), 0, "once");

    // Back on the payment page: the released time sends them to pick again, its charge gone; nothing to pay for it.
    const back = await app.request(HOST + step);
    const page = await back.text();
    assert.match(page, /has been released\. Pick a time again\./);
    assert.match(page, /Step 2 of 3/);
    const [after] = await s.db.sql`select data from submissions`;
    assert.deepEqual(after.data._charges, {});
    assert.equal(await complete(), false);

    // Paid, by the webhook's word: complete, once.
    const [pay] = await s.db.sql<{ id: string }>`update payments set status = 'paid' returning id::text as id`;
    await completePaidSubmission(s.db, pay.id);
    const [{ completed_at: at }] = await s.db.sql`select completed_at from submissions`;
    assert.ok(at);
    await completePaidSubmission(s.db, pay.id);
    assert.equal(String((await s.db.sql`select completed_at from submissions`)[0].completed_at), String(at), "a second delivery changes nothing");
  }));

test("a paid hold is never released; an unfinished form's is, a finished one's is not, sender or not", (t) =>
  withDb(t, async (s) => {
    const type = await intake(s);
    const mk = async (hold: string | null, start: string, submission: number) => {
      const [r] = await s.db.sql`insert into bookings (type_id, resource_id, starts_at, ends_at, name, email, location_kind, submission_id, hold_until)
        select ${type.id}::bigint, resource_id, ${start}::timestamptz, ${start}::timestamptz + interval '50 minutes', 'A', 'a@example.com', 'video', ${submission}::bigint, ${hold}::timestamptz
        from booking_type_hosts where type_id = ${type.id}::bigint returning id::text as id`;
      return r.id;
    };
    const past = new Date(Date.now() - 60_000).toISOString();
    const paid = await mk(past, "2099-01-01T10:00:00Z", 9);
    const walkedAway = await mk(past, "2099-01-01T12:00:00Z", 10);
    const finished = await mk(new Date(Date.now() + 60_000).toISOString(), "2099-01-01T14:00:00Z", 11);
    await s.db.sql`insert into payments (amount_cents, currency, status, kind, ref_type, ref_id) values (12000, 'usd', 'paid', 'full', 'submission', '9')`;
    // The form is complete in an app with no email sender: the hold still ends.
    assert.equal((await confirmFormBooking(s.db, "11", null, { domain: "counsel.example" })).status, "none");
    assert.equal(await releaseLapsedHolds(s.db, new Date(Date.now() + 120_000)), 1);
    const rows = await s.db.sql`select id::text as id, status, hold_until from bookings order by id`;
    assert.deepEqual(rows.map((r) => [r.id, r.status]), [[paid, "confirmed"], [walkedAway, "cancelled"], [finished, "confirmed"]]);
    assert.equal(rows[2].hold_until, null);
  }));

test("a booking made in a form is confirmed once, when the form is complete, with the booker's link to change or cancel it", (t) =>
  withDb(t, async (s) => {
    await intake(s, "");
    const fields = INTAKE.filter((f) => f.type !== "payment");
    await seedForm(s.db, { key: "intake", title: "Intake", fields }, "website");
    const mail: Message[] = [];
    const send: Send = async (m) => (mail.push(m), { status: "sent", via: "test" });
    const app = new Hono();
    app.route("/", formRoutes(() => s.db, {
      source: "website", page: (_c, title, body) => `<title>${title}</title>${String(body)}`,
      steps: { booking: bookingStep(() => s.db, { source: "website" }) },
      onComplete: async (_c, id) => void (await confirmFormBooking(s.db, id, send, { domain: "counsel.example", manageBase: "https://counsel.example/book" })),
    }));
    app.route("/book", bookingPages(() => s.db, { base: "/book", domain: "counsel.example", css: "/site.css", source: "website" }));
    const post = (path: string, body: Record<string, string>) =>
      app.request(HOST + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "counsel.example" }, body: new URLSearchParams(body).toString() });

    const step = (await post("/forms/intake", { name: "Ann Lee", email: "ann@example.com", goal: "Sleep better", company_website: "", _started: await makeStamp("intake", undefined, Date.now() - 10_000) })).headers.get("location")!;
    assert.equal(mail.length, 0, "the questions alone confirm nothing");
    const html = await (await app.request(HOST + step)).text();
    const hidden = (n: string) => new RegExp(`name="${n}" value="([^"]*)"`).exec(html)![1].replace(/&amp;/g, "&");
    const start = /name="start" value="([^"]+)"/.exec(html)![1];
    const action = /<form method="post" action="([^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
    const booked = { _draft: hidden("_draft"), _step: hidden("_step"), start };
    await Promise.all([post(action, booked), post(action, booked)]); // a double click confirms once

    assert.equal(mail.length, 1);
    assert.equal(mail[0].to, "ann@example.com");
    const link = /https:\/\/counsel\.example\/book\/manage\/[A-Za-z0-9_-]{43}/.exec(mail[0].text)![0];
    assert.match(await (await app.request(link.replace("https://counsel.example", HOST))).text(), /Intake session/);
    const [sub] = await s.db.sql`select completed_at from submissions`;
    assert.ok(sub.completed_at, "a form that ends with its booking is complete once booked");
  }));

test("a paid form's booking is confirmed on payment, by whichever app has a sender, once", (t) =>
  withDb(t, async (s) => {
    await intake(s);
    await seedForm(s.db, { key: "intake", title: "Intake", fields: INTAKE }, "website");
    const stripe: Stripe = async (_m, path) => {
      if (path === "/v1/checkout/sessions") return { id: "cs_1", url: "https://checkout.stripe.example/1", livemode: false } as any;
      throw new Error(path);
    };
    const mail: Message[] = [];
    const send: Send = async (m) => (mail.push(m), { status: "sent", via: "test" });
    const opts = { domain: "counsel.example", manageBase: "https://counsel.example/book" };
    const app = new Hono();
    app.route("/", formRoutes(() => s.db, {
      source: "website", page: (_c, title, body) => `<title>${title}</title>${String(body)}`,
      steps: { booking: bookingStep(() => s.db, { source: "website" }), payment: paymentStep(() => s.db, () => stripe, { source: "website" }) },
      onComplete: async (_c, id) => void (await confirmFormBooking(s.db, id, send, opts)),
    }));
    const post = (body: Record<string, string>) =>
      app.request(HOST + "/forms/intake", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "counsel.example" }, body: new URLSearchParams(body).toString() });
    const step = (await post({ name: "Ann Lee", email: "ann@example.com", goal: "Sleep better", company_website: "", _started: await makeStamp("intake", undefined, Date.now() - 10_000) })).headers.get("location")!;
    const key = new URL(step, HOST).searchParams.get("k")!;
    const start = /name="start" value="([^"]+)"/.exec(await (await app.request(HOST + step)).text())![1];
    await post({ _draft: key, _step: "1", start });
    assert.equal((await post({ _draft: key })).headers.get("location"), "https://checkout.stripe.example/1");
    assert.equal(mail.length, 0, "a time held for payment confirms nothing");

    // Paid: the webhook's afterPaid, in an app without a sender, then in one with.
    const [pay] = await s.db.sql<{ id: string }>`update payments set status = 'paid' returning id::text as id`;
    const id = (await completePaidSubmission(s.db, pay.id))!;
    assert.ok(id);
    assert.equal(emailSender({}), null, "an app with no sender set up");
    assert.equal((await confirmFormBooking(s.db, id, emailSender({}), opts)).status, "none");
    const failing: Send = async () => ({ status: "failed", via: "test", error: "503" });
    assert.equal((await confirmFormBooking(s.db, id, failing, opts)).status, "failed");
    assert.equal((await confirmFormBooking(s.db, id, send, opts)).status, "sent", "left for the app with a sender, and a failed send gave the claim back");
    assert.equal((await confirmFormBooking(s.db, (await completePaidSubmission(s.db, pay.id))!, send, opts)).status, "none", "a second delivery sends nothing");
    assert.equal(mail.length, 1);
    const [b] = await s.db.sql`select hold_until, confirmation_sent_at from bookings`;
    assert.deepEqual([b.hold_until, !!b.confirmation_sent_at], [null, true], "paid: no longer held");
  }));

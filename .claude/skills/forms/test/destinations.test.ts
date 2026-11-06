// Lead destinations against a scratch database and a fake outside world: when a
// lead goes, what it sends, that it goes once, and what a failure leaves behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { applySchema } from "../../data/migrate";
import { makeStamp } from "../../data/spam";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import { formsAdmin } from "../admin";
import { checkDestination, deliveriesOf, destinationsOf, fillTemplate, leadMoment, resendDelivery } from "../destinations";
import { formRoutes } from "../routes";
import { CONTACT_FORM, insertOnce, seedForm } from "../store";

/** A submission as a form saves it, each with a key of its own. */
const insertSubmission = (db: Scratch["db"], sub: Parameters<typeof insertOnce>[1]) => insertOnce(db, sub, crypto.randomUUID()).then((r) => r.id);

const schema = ["../schema.sql", "../../customers/schema.sql"].map((p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8")).join(";\n");
const ENV = { PHOENIX_URL: "https://tt.example", MACHINE_TOKEN: "m", LEAD_WEBHOOK_URL: "https://hooks.example/lead" };
const noWait = async () => {};

/** Answers each call in turn; the last answer repeats. */
function world(...answers: (Response | Error)[]) {
  const calls: { url: string; body: string }[] = [];
  const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a.clone();
  }) as typeof fetch;
  return { calls, doFetch };
}

const ok = (body: unknown = { id: "a1" }) => new Response(JSON.stringify(body), { status: 200 });

async function setUp(t: { skip: (m: string) => void }) {
  const s = await scratch();
  if (!s) {
    t.skip(why);
    return null;
  }
  await applySchema(s.db, schema);
  await applySchema(s.db, schema);
  await seedForm(s.db, CONTACT_FORM, "website");
  return s;
}

const destination = (s: Scratch, over: Partial<{ key: string; kind: string; target: string; path: string; template: unknown; forms: string[]; send_when: string; needs: string[] }> = {}) =>
  s.db.sql`insert into lead_destinations (key, title, kind, target, path, template, forms, send_when, needs)
    values (${over.key ?? "zap"}, 'Their CRM', ${over.kind ?? "webhook"}, ${over.target ?? "LEAD_WEBHOOK_URL"}, ${over.path ?? null},
            ${over.template ? JSON.stringify(over.template) : null}::jsonb, ${over.forms ?? []}::text[], ${over.send_when ?? "answered"}, ${over.needs ?? []}::text[])`;

const lead = (s: Scratch, over: Record<string, unknown> = {}) =>
  insertSubmission(s.db, { form_key: "contact", name: "Ann Marie Lee", email: "ann@example.com", phone: "555 010 2030", source: "website", page: "/roof", status: "new", data: { message: "Leaking", _utm: { source: "facebook", campaign: "spring | 4:5" }, _click: { fbclid: "AbC" }, _landing: "/roof", _consent: { x: "y" } }, ...over } as Parameters<typeof insertSubmission>[1]).then(String);

test("a lead goes flat to a webhook, with what it sent and what came back on its row", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    await destination(s);
    const id = await lead(s);
    const w = world(ok());
    await leadMoment(s.db, ENV, id, "complete", { doFetch: w.doFetch });
    assert.equal(w.calls.length, 1);
    assert.equal(w.calls[0].url, "https://hooks.example/lead");
    const sent = JSON.parse(w.calls[0].body);
    assert.equal(sent.first_name, "Ann");
    assert.equal(sent.last_name, "Marie Lee");
    assert.equal(sent.message, "Leaking");
    assert.equal(sent.utm_campaign, "spring | 4:5");
    assert.equal(sent.fbclid, "AbC");
    assert.equal(sent.landing_page, "/roof");
    assert.equal(sent._consent, undefined);
    const [d] = await deliveriesOf(s.db, id);
    assert.equal(d.status, "sent");
    assert.equal(d.response_status, 200);
    assert.match(d.response_body!, /a1/);
    assert.equal(JSON.parse(d.body!).email, "ann@example.com");
    assert.ok(d.sent_at);

    // Seen again, by another request or another app: it went, so it does not go twice.
    await leadMoment(s.db, ENV, id, "complete", { doFetch: w.doFetch });
    assert.equal(w.calls.length, 1);
  } finally {
    await s.drop();
  }
});

test("a connection goes through the gateway with its template, an absent field left out", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    await destination(s, {
      key: "i360", kind: "connection", target: "i360", path: "/services/apexrest/i360core/elead/create",
      template: { i360core__First_Name__c: "{{first_name}}", i360core__Phone__c: "{{phone}}", i360core__Source__c: "Web", i360core__Appointment_Date_Time__c: "{{appointment_start}}", note: "From {{utm_source}}" },
    });
    const id = await lead(s);
    const w = world(ok());
    await leadMoment(s.db, ENV, id, "answered", { doFetch: w.doFetch });
    assert.equal(w.calls[0].url, "https://tt.example/api/machine/gateway/i360/services/apexrest/i360core/elead/create");
    assert.deepEqual(JSON.parse(w.calls[0].body), { i360core__First_Name__c: "Ann", i360core__Phone__c: "555 010 2030", i360core__Source__c: "Web", note: "From facebook" });
  } finally {
    await s.drop();
  }
});

test("a blip is tried again; a vendor's refusal is not; a failure tells the team once and Resend sends it", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    await destination(s);
    await s.db.sql`update forms set notify_emails = '{owner@example.com}' where key = 'contact'`;
    const blip = await lead(s);
    const w1 = world(new Error("timed out"), new Response("busy", { status: 503 }), ok());
    await leadMoment(s.db, ENV, blip, "complete", { doFetch: w1.doFetch, wait: noWait });
    assert.equal(w1.calls.length, 3);
    assert.equal((await deliveriesOf(s.db, blip))[0].status, "sent");

    const refused = await lead(s, { email: "bo@example.com", name: "Bo" });
    const w2 = world(new Response("bad field", { status: 400 }));
    await leadMoment(s.db, ENV, refused, "complete", { doFetch: w2.doFetch, wait: noWait, link: "https://site.example/admin/submissions/9" });
    const toVendor = w2.calls.filter((c) => c.url.startsWith("https://hooks.example"));
    const toTeam = w2.calls.filter((c) => c.url.includes("taskandtool-email"));
    assert.equal(toVendor.length, 1, "a 400 will not change");
    assert.equal(toTeam.length, 1);
    assert.match(toTeam[0].body, /Bo did not reach Their CRM/);
    assert.match(toTeam[0].body, /won't be sent again unless you resend it/);
    assert.match(toTeam[0].body, /admin\/submissions\/9/);
    let [d] = await deliveriesOf(s.db, refused);
    assert.equal(d.status, "failed");
    assert.equal(d.error, "Their CRM refused this lead (400).");
    assert.equal(d.response_body, "bad field");

    const w3 = world(ok());
    assert.equal(await resendDelivery(s.db, ENV, refused, d.id, { doFetch: w3.doFetch }), true);
    [d] = await deliveriesOf(s.db, refused);
    assert.equal(d.status, "sent");
    assert.equal(d.error, null);
    assert.equal(await resendDelivery(s.db, ENV, blip, d.id, { doFetch: w3.doFetch }), false, "another submission's row");

    // A press that fails shows on the page the person is looking at: no second email.
    const w4 = world(new Response("still bad", { status: 400 }));
    await s.db.sql`update lead_deliveries set status = 'failed' where id = ${d.id}::bigint`;
    await resendDelivery(s.db, ENV, refused, d.id, { doFetch: w4.doFetch });
    assert.equal(w4.calls.filter((c) => c.url.includes("taskandtool-email")).length, 0);
  } finally {
    await s.drop();
  }
});

test("send_when and needs: it waits for the last step, and a missing field fails there", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    await destination(s, { key: "late", send_when: "complete" });
    await destination(s, { key: "picky", needs: ["address"] });
    await destination(s, { key: "soon" });
    const id = await lead(s);
    const w = world(ok());
    await leadMoment(s.db, ENV, id, "answered", { doFetch: w.doFetch });
    const byKey = async () => Object.fromEntries((await s.db.sql<{ key: string; status: string; error: string | null }>`
      select d.key, l.status, l.error from lead_deliveries l join lead_destinations d on d.id = l.destination_id`).map((r) => [r.key, r]));
    let rows = await byKey();
    assert.equal(rows.soon.status, "sent");
    assert.equal(rows.late.status, "waiting");
    assert.equal(rows.picky.status, "waiting");
    assert.equal(rows.picky.error, "Missing address");
    assert.equal(w.calls.length, 1);

    await leadMoment(s.db, ENV, id, "complete", { doFetch: w.doFetch });
    rows = await byKey();
    assert.equal(rows.soon.status, "sent");
    assert.equal(rows.late.status, "sent");
    assert.equal(rows.picky.status, "failed");
    assert.equal(w.calls.filter((c) => c.url.startsWith("https://hooks")).length, 2);
  } finally {
    await s.drop();
  }
});

test("which leads a destination takes: spam never, a form with leads off only when named", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    await destination(s, { key: "all" });
    await destination(s, { key: "contact-only", forms: ["contact"] });
    await destination(s, { key: "news", forms: ["newsletter"] });
    await seedForm(s.db, { ...CONTACT_FORM, key: "newsletter", leads: false }, "website");
    const w = world(ok());
    const count = async (id: string) => (await deliveriesOf(s.db, id)).length;

    const spam = await lead(s, { status: "spam" });
    await leadMoment(s.db, ENV, spam, "complete", { doFetch: w.doFetch });
    assert.equal(await count(spam), 0);

    const contact = await lead(s);
    await leadMoment(s.db, ENV, contact, "complete", { doFetch: w.doFetch });
    assert.equal(await count(contact), 2);

    const news = await lead(s, { form_key: "newsletter" });
    await leadMoment(s.db, ENV, news, "complete", { doFetch: w.doFetch });
    const names = await s.db.sql<{ key: string }>`select d.key from lead_deliveries l join lead_destinations d on d.id = l.destination_id where l.submission_id = ${news}::bigint`;
    assert.deepEqual(names.map((r) => r.key), ["news"]);
  } finally {
    await s.drop();
  }
});

test("an email destination says when only Resend or Postmark could reach the address", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    await destination(s, { key: "inbox", kind: "email", target: "sales@client.example" });
    const id = await lead(s);
    const w = world(new Response(JSON.stringify({ sent: [], skipped: ["sales@client.example"] }), { status: 200 }));
    await leadMoment(s.db, ENV, id, "complete", { doFetch: w.doFetch, wait: noWait });
    const [d] = await deliveriesOf(s.db, id);
    assert.equal(d.status, "failed");
    assert.match(d.error!, /cannot open this app/);
    assert.match(d.body!, /^Name: Ann Marie Lee\nEmail: ann@example.com\nPhone: 555 010 2030\nWhat do you need\?: Leaking\nSource: facebook\nCampaign: spring \| 4:5\nPage: \/roof/);
    assert.doesNotMatch(d.body!, /First name|Utm|Fbclid|Form title/);
  } finally {
    await s.drop();
  }
});

test("a webhook with no secret, or one that is not https, fails saying so and tries nothing", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    await destination(s, { key: "a", target: "NOT_SET" });
    await destination(s, { key: "b", target: "PLAIN" });
    const id = await lead(s);
    const w = world(ok());
    await leadMoment(s.db, { ...ENV, PLAIN: "http://hooks.example" }, id, "complete", { doFetch: w.doFetch, wait: noWait });
    const errors = (await deliveriesOf(s.db, id)).map((d) => d.error).sort();
    assert.ok(errors.some((e) => /secret NOT_SET/.test(e!)));
    assert.ok(errors.some((e) => /PLAIN is not a valid https address/.test(e!)));
    assert.equal(w.calls.filter((c) => c.url.includes("hooks.example")).length, 0);
  } finally {
    await s.drop();
  }
});

test("the routes send a one-page form after saving, and the team sees it on the submission", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  const real = globalThis.fetch;
  const w = world(ok({ id: "z9" }));
  globalThis.fetch = w.doFetch;
  process.env.LEAD_WEBHOOK_URL = ENV.LEAD_WEBHOOK_URL;
  try {
    await destination(s);
    const app = new Hono();
    app.route("/", formRoutes(() => s.db, { source: "website", page: (_c, title, body) => `<title>${title}</title>${String(body)}` }));
    app.route("/admin/submissions", formsAdmin(() => s.db, { base: "/admin/submissions", css: "/site.css", timeZone: "UTC" }));
    const res = await app.request("https://site.example/forms/contact", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "site.example" },
      body: new URLSearchParams({ name: "Ann", email: "ann@example.com", _started: await makeStamp("contact", Date.now() - 10_000) }).toString(),
    });
    assert.equal(res.status, 303);
    for (let i = 0; i < 50 && !w.calls.length; i++) await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 50; i++) {
      const [row] = await s.db.sql<{ status: string }>`select status from lead_deliveries`;
      if (row?.status === "sent") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const [{ id }] = await s.db.sql<{ id: string }>`select id::text as id from submissions`;
    const page = await (await app.request(`https://site.example/admin/submissions/${id}`, { headers: { "x-tasktool-user": "o@example.com", host: "site.example" } })).text();
    assert.match(page, /Destinations/);
    assert.match(page, /Their CRM/);
    assert.match(page, /z9/);
  } finally {
    globalThis.fetch = real;
    delete process.env.LEAD_WEBHOOK_URL;
    await s.drop();
  }
});

test("the fields and the templates, with no database", () => {
  assert.deepEqual(fillTemplate({ a: "{{x}}", b: "{{gone}}", c: ["{{x}}", "{{gone}}"], d: { e: "x is {{x}}, {{gone}}." }, f: 3 }, { x: 7 }), { a: 7, c: [7], d: { e: "x is 7, ." }, f: 3 });
  assert.deepEqual(checkDestination({ title: "i360", kind: "connection", target: "i360", path: "/x" }), { ok: true, value: { title: "i360", kind: "connection", target: "i360", path: "/x", template: null, forms: [], send_when: "answered", needs: [], active: true } });
  const bad = checkDestination({ kind: "webhook", target: "https://hooks.zapier.com/x" });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.problems.some((p) => /name of the secret/.test(p)), "the address itself never goes in the database");
  assert.ok(!bad.ok && bad.problems.some((p) => /title/.test(p)));
  const email = checkDestination({ title: "Inbox", kind: "email", target: "a@b.example, nope", template: {} });
  assert.ok(!email.ok && email.problems.length === 2);
  assert.equal(checkDestination({ title: "x", kind: "webhook", target: "A_B", send_when: "soon" }).ok, false);
});

test("a timeout is not tried again, since the vendor may have it, and an address never reaches a row or an email", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    await destination(s, { key: "slow" });
    const id = await lead(s);
    const slow = world(new DOMException("timed out", "TimeoutError"));
    await leadMoment(s.db, ENV, id, "complete", { doFetch: slow.doFetch, wait: noWait });
    assert.equal(slow.calls.filter((c) => c.url.includes("hooks.example")).length, 1);
    assert.match((await deliveriesOf(s.db, id))[0].error!, /did not answer in 10 seconds/);

    await s.db.sql`update lead_destinations set target = 'BAD_URL'`;
    const other = await lead(s, { email: "bo@example.com" });
    const w = world(ok());
    await leadMoment(s.db, { ...ENV, BAD_URL: "https://hooks zapier.com/secret-token-abc" }, other, "complete", { doFetch: w.doFetch, wait: noWait });
    const [bad] = await deliveriesOf(s.db, other);
    assert.doesNotMatch(bad.error!, /secret-token-abc/);
    assert.ok(!w.calls.some((c) => c.body.includes("secret-token-abc")));

    await s.db.sql`update lead_destinations set target = 'LEAD_WEBHOOK_URL'`;
    const third = await lead(s, { email: "cy@example.com" });
    const down = world(new TypeError("fetch failed for https://hooks.example/secret-token-abc"));
    await leadMoment(s.db, ENV, third, "complete", { doFetch: down.doFetch, wait: noWait });
    const [d] = await deliveriesOf(s.db, third);
    assert.equal(d.error, "Could not reach Their CRM (TypeError).");
    assert.equal(d.attempts, 1, "tries are one claim");
    assert.equal(down.calls.filter((c) => c.url.includes("hooks.example")).length, 3);
  } finally {
    await s.drop();
  }
});

test("a visitor's line breaks stay inside their answer in an email", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    await destination(s, { key: "inbox", kind: "email", target: "sales@client.example" });
    const id = await lead(s, { data: { message: "Hi\nPhone: 555-EVIL\nOpen it: https://evil.example" } });
    const w = world(new Response(JSON.stringify({ sent: ["sales@client.example"] })));
    await leadMoment(s.db, ENV, id, "complete", { doFetch: w.doFetch });
    const [d] = await deliveriesOf(s.db, id);
    assert.match(d.body!, /\n    Phone: 555-EVIL\n    Open it: https:\/\/evil\.example/);
  } finally {
    await s.drop();
  }
});

test("a form with leads off shows only the destinations that name it", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    await seedForm(s.db, { ...CONTACT_FORM, key: "news", leads: false }, "website");
    await destination(s, { key: "all" });
    await destination(s, { key: "named", forms: ["news"] });
    assert.deepEqual((await destinationsOf(s.db, "news")).map((d) => d.key), ["named"]);
    assert.deepEqual((await destinationsOf(s.db, "contact")).map((d) => d.key), ["all"]);
    assert.equal((await destinationsOf(s.db)).length, 2);
  } finally {
    await s.drop();
  }
});

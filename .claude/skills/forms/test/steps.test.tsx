import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { applySchema } from "../../data/migrate";
import { makeStamp } from "../../data/spam";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import { checkFields, stepsOf, type Field } from "../fields";
import { embedForm, formRoutes } from "../routes";
import type { FormSteps, StepContext } from "../steps";
import { seedForm } from "../store";
import { formsAdmin } from "../admin";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

const INTAKE: Field[] = [
  { name: "name", label: "Name", type: "text", required: true },
  { name: "email", label: "Email", type: "email", required: true },
  { name: "about", label: "About you", type: "page" },
  { name: "goal", label: "What brings you here?", type: "textarea", required: true },
  { name: "when", label: "Pick a time", type: "booking", booking_type: "intake" },
  { name: "pay", label: "Pay for the session", type: "payment" },
];

test("steps: a page starts one; booking and payment are steps of their own, after the questions", () => {
  const steps = stepsOf(INTAKE);
  assert.deepEqual(steps.map((s) => [s.kind, s.label, s.kind === "fields" ? s.fields.map((f) => f.name) : s.field.name]), [
    ["fields", null, ["name", "email"]],
    ["fields", "About you", ["goal"]],
    ["booking", "Pick a time", "when"],
    ["payment", "Pay for the session", "pay"],
  ]);
  assert.equal(stepsOf([{ name: "name", label: "Name", type: "text" }]).length, 1, "a form with no steps is one");
  assert.deepEqual(checkFields(INTAKE).problems, {});

  const bad = checkFields([
    { name: "pay", label: "Pay", type: "payment" },
    { name: "name", label: "Name", type: "text" },
    { name: "when", label: "When", type: "booking" },
  ]);
  assert.deepEqual(bad.problems, {
    "0": "A booking or payment step comes after every question.",
    "2": "Say which booking type this step books, by its slug.",
  });
  assert.deepEqual(bad.fields.map((f) => f.name), ["name"], "a step out of place is left out");
  assert.equal(checkFields([{ name: "pay", label: "Pay", type: "payment" }]).problems["0"],
    "Ask at least one question (their name or email) before a booking or payment step.");
});

const pageOf = (_c: unknown, title: string, body: unknown) => `<!doctype html><title>${title}</title>${String(body)}`;
const HOST = "https://site.example";
const send = (app: Hono, path: string, fields: Record<string, string>) =>
  app.request(HOST + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "site.example" }, body: new URLSearchParams(fields).toString() });
const keyOf = (location: string | null) => new URL(location!, HOST).searchParams.get("k")!;

async function withDb(t: { skip: (m: string) => void }, fn: (s: Scratch) => Promise<void>) {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await applySchema(s.db, schema);
    await applySchema(s.db, schema);
    await fn(s);
  } finally {
    await s.drop();
  }
}

test("a form with steps: a draft between pages, a submission once the questions are done, then the booking and payment steps", (t) =>
  withDb(t, async (s) => {
    await seedForm(s.db, { key: "intake", title: "Intake", fields: INTAKE }, "website");
    const seen: { kind: string; ctx: StepContext }[] = [];
    const steps: FormSteps = {
      booking: {
        render: (_c, ctx, shown) => <form method="post" action={ctx.action}>{ctx.hidden}<p>Times for {ctx.field.booking_type}</p>{shown.errors?.slot ? <p>{shown.errors.slot}</p> : null}</form>,
        take: async (_c, ctx, input) => {
          seen.push({ kind: "booking", ctx });
          return input.slot ? { ok: true } : { ok: false, errors: { slot: "Pick a time." } };
        },
      },
      payment: {
        render: (_c, ctx) => <form method="post" action={ctx.action}>{ctx.hidden}<p>Pay now</p></form>,
        take: async (_c, ctx) => (seen.push({ kind: "payment", ctx }), { ok: true, redirect: "https://checkout.stripe.example/s/1" }),
      },
    };
    const app = new Hono();
    app.route("/", formRoutes(() => s.db, { source: "website", page: pageOf, steps }));
    app.get("/intake", async (c) => c.html(String(await embedForm(c, s.db, "intake"))));

    // The first page, embedded, says where it is; the spam stamp rides only on it.
    const first = await (await app.request(HOST + "/intake")).text();
    assert.match(first, /Step 1 of 4/);
    assert.match(first, /name="_started"/);
    assert.match(first, />Next</);
    assert.doesNotMatch(first, /What brings you here/);

    // Page 1: a draft, no submission yet.
    const stamp = await makeStamp("intake", Date.now() - 10_000);
    let res = await send(app, "/forms/intake", { name: "Ann Lee", email: "Ann@Example.com", company_website: "", _started: stamp, _page: "/intake" });
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location")!, /^\/forms\/intake\/next\?k=/);
    const key = keyOf(res.headers.get("location"));
    assert.equal((await s.db.sql`select count(*)::int as n from submissions`)[0].n, 0);
    const [draft] = await s.db.sql`select * from submission_drafts`;
    assert.equal(draft.step, 1);
    assert.equal(draft.email, "ann@example.com");
    assert.notEqual(draft.key_hash, key, "only the hash is stored");

    // Page 2 shows its own question, carries the key and no stamp.
    res = await app.request(HOST + `/forms/intake/next?k=${encodeURIComponent(key)}`);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    let html = await res.text();
    assert.match(html, /Step 2 of 4/);
    assert.match(html, /About you/);
    assert.match(html, /name="_draft"/);
    assert.doesNotMatch(html, /name="_started"/);

    // A missing answer: the same step again, 422; nothing moves.
    res = await send(app, "/forms/intake", { _draft: key });
    assert.equal(res.status, 422);
    assert.match(await res.text(), /Step 2 of 4/);

    // The last question: the submission exists, once, with every answer; on to the booking step.
    res = await send(app, "/forms/intake", { _draft: key, goal: "Sleep better" });
    assert.match(res.headers.get("location")!, /\/forms\/intake\/next\?k=/);
    res = await send(app, "/forms/intake", { _draft: key, goal: "Twice" }); // a double post changes nothing
    const subs = await s.db.sql`select * from submissions`;
    assert.equal(subs.length, 1);
    assert.deepEqual([subs[0].email, subs[0].name, subs[0].data.goal, subs[0].page, subs[0].status], ["ann@example.com", "Ann Lee", "Sleep better", "/intake", "new"]);

    // The booking step: the adapter's body, then its errors, then on.
    html = await (await app.request(HOST + `/forms/intake/next?k=${encodeURIComponent(key)}`)).text();
    assert.match(html, /Step 3 of 4/);
    assert.match(html, /Times for intake/);
    res = await send(app, "/forms/intake", { _draft: key });
    assert.equal(res.status, 422);
    assert.match(await res.text(), /Pick a time\./);
    res = await send(app, "/forms/intake", { _draft: key, slot: "2026-11-02T15:00:00Z" });
    assert.match(res.headers.get("location")!, /\/forms\/intake\/next\?k=/);
    assert.equal(seen[1].ctx.submission.id, subs[0].id, "the step names the submission");
    assert.equal(seen[1].ctx.submission.email, "ann@example.com");

    // The payment step sends them where the adapter says.
    res = await send(app, "/forms/intake", { _draft: key });
    assert.equal(res.headers.get("location"), "https://checkout.stripe.example/s/1");
    assert.equal(seen.at(-1)!.kind, "payment");
    assert.equal(seen.at(-1)!.ctx.next, `${HOST}/forms/intake/thanks`);
    // Sent to pay, the payment stays their step: a cancelled checkout comes back to it.
    res = await app.request(HOST + `/forms/intake/next?k=${encodeURIComponent(key)}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Pay now/);
  }));

test("an unfinished form stays a draft; a made-up key starts again; an unwired step says so", (t) =>
  withDb(t, async (s) => {
    await seedForm(s.db, { key: "intake", title: "Intake", fields: INTAKE }, "website");
    const app = new Hono();
    app.route("/", formRoutes(() => s.db, { source: "website", page: pageOf }));
    app.route("/admin/forms", formsAdmin(() => s.db, { base: "/admin/forms", css: "/x.css", timeZone: "UTC", source: "website" }));
    const stamp = await makeStamp("intake", Date.now() - 10_000);
    let res = await send(app, "/forms/intake", { name: "Bo", email: "bo@example.com", company_website: "", _started: stamp });
    const key = keyOf(res.headers.get("location"));
    assert.equal((await s.db.sql`select count(*)::int as n from submission_drafts where submission_id is null`)[0].n, 1);
    assert.equal((await s.db.sql`select count(*)::int as n from submissions`)[0].n, 0, "nobody else sees an unfinished one");

    res = await send(app, "/forms/intake", { _draft: "x".repeat(43), goal: "x" });
    assert.equal(res.status, 404);
    assert.match(await res.text(), /Start again/);
    assert.equal((await app.request(HOST + "/forms/intake/next?k=nope")).status, 404);

    res = await send(app, "/forms/intake", { _draft: key, goal: "Rest" });
    res = await app.request(HOST + `/forms/intake/next?k=${encodeURIComponent(key)}`);
    assert.equal(res.status, 500);
    assert.match(await res.text(), /not ready yet/);
    assert.equal((await s.db.sql`select count(*)::int as n from submissions`)[0].n, 1, "the answers are kept");

    // The team sees who stopped part way, apart from the submissions.
    const other = await send(app, "/forms/intake", { name: "Cy", email: "cy@example.com", company_website: "", _started: stamp });
    assert.equal(other.status, 303);
    const team = { headers: { "x-tasktool-user": "owner@example.com", host: "site.example" } };
    const unfinished = await (await app.request(HOST + "/admin/forms/submissions/unfinished", team)).text();
    assert.match(unfinished, /cy@example\.com|Cy/);
    assert.doesNotMatch(unfinished, />Bo</, "Bo finished the questions");
    // Bo's submission is there, not complete: the booking and payment steps are still to do.
    const list = await (await app.request(HOST + "/admin/forms/submissions", team)).text();
    assert.match(list, /Not complete/);
    const [bo] = await s.db.sql<{ id: string }>`select id::text as id from submissions`;
    assert.match(await (await app.request(HOST + `/admin/forms/submissions/${bo.id}`, team)).text(), /Not yet: a booking or payment step is still to do/);

    // A page of its own for a link.
    const start = await (await app.request(HOST + "/forms/intake/start")).text();
    assert.match(start, /Step 1 of 4/);
  }));

test("a form with two pages and nothing after: the submission is made on the last page, and they are thanked", (t) =>
  withDb(t, async (s) => {
    await seedForm(s.db, { key: "survey", title: "Survey", fields: [
      { name: "email", label: "Email", type: "email", required: true },
      { name: "p2", label: "Two", type: "page" },
      { name: "rating", label: "How did we do?", type: "radio", options: ["Well", "Badly"], required: true },
    ] }, "website");
    const app = new Hono();
    app.route("/", formRoutes(() => s.db, { source: "website", page: pageOf }));
    const stamp = await makeStamp("survey", Date.now() - 10_000);
    let res = await send(app, "/forms/survey", { email: "cy@example.com", company_website: "", _started: stamp });
    const key = keyOf(res.headers.get("location"));
    res = await send(app, "/forms/survey", { _draft: key, rating: "Well" });
    assert.equal(res.headers.get("location"), "/forms/survey/thanks");
    const [sub] = await s.db.sql`select email::text as email, data, completed_at from submissions`;
    assert.deepEqual([sub.email, sub.data], ["cy@example.com", { rating: "Well" }], "nothing extra kept for a form that sells nothing");
    assert.ok(sub.completed_at, "nothing after the questions: complete when they are answered");
  }));

test("consent on two pages keeps both wordings; a page posted twice is applied once", (t) =>
  withDb(t, async (s) => {
    await seedForm(s.db, { key: "join", title: "Join", fields: [
      { name: "email", label: "Email", type: "email", required: true },
      { name: "privacy", label: "I agree to the privacy terms", type: "consent", required: true },
      { name: "p2", label: "Two", type: "page" },
      { name: "news", label: "Send me news", type: "consent" },
      { name: "p3", label: "Three", type: "page" },
      { name: "note", label: "Anything else?", type: "text" },
    ] }, "website");
    const app = new Hono();
    app.route("/", formRoutes(() => s.db, { source: "website", page: pageOf }));
    let res = await send(app, "/forms/join", { email: "di@example.com", privacy: "yes", company_website: "", _started: await makeStamp("join", Date.now() - 10_000) });
    const key = keyOf(res.headers.get("location"));
    res = await send(app, "/forms/join", { _draft: key, _step: "1", news: "yes" });
    // The same page again, arriving after the first was saved: nothing is applied to page 3.
    res = await send(app, "/forms/join", { _draft: key, _step: "1", news: "yes" });
    assert.match(res.headers.get("location")!, /\/forms\/join\/next/);
    assert.equal((await s.db.sql`select step from submission_drafts`)[0].step, 2);
    res = await send(app, "/forms/join", { _draft: key, _step: "2", note: "hi" });
    const [sub] = await s.db.sql`select data from submissions`;
    assert.deepEqual(sub.data._consent, { privacy: "I agree to the privacy terms", news: "Send me news" });
    assert.equal(sub.data.note, "hi");
  }));

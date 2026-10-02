import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { applySchema } from "../../data/migrate";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import { embedForm, formRoutes, summary } from "../routes";
import { formsAdmin } from "../admin";
import { CONTACT_FORM, seedForm } from "../store";
import { makeStamp } from "../../data/spam";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function site(s: Scratch) {
  const app = new Hono();
  app.route("/", formRoutes(() => s.db, { source: "website", page: (_c, title, body) => `<!doctype html><title>${title}</title>${String(body)}` }));
  app.get("/contact", async (c) => c.html(String(await embedForm(c, s.db, "contact"))));
  app.route("/admin/forms", formsAdmin(() => s.db, { base: "/admin/forms", css: "/site.css", timeZone: "America/Chicago", source: "website" }));
  return app;
}

const post = (app: Hono, path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  app.request(`https://site.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", host: "site.example", ...headers },
    body: new URLSearchParams(fields).toString(),
  });

const team = { "x-tasktool-user": "Owner@Example.com", origin: "https://site.example" };

async function setUp(t: { skip: (m: string) => void }) {
  const s = await scratch();
  if (!s) {
    t.skip(why);
    return null;
  }
  await applySchema(s.db, schema);
  await applySchema(s.db, schema); // every app runs it on start: twice is a no-op
  await seedForm(s.db, CONTACT_FORM, "website");
  await seedForm(s.db, { ...CONTACT_FORM, title: "Changed" }, "crm"); // never overwrites
  return s;
}

const oldStamp = () => makeStamp("contact", undefined, Date.now() - 10_000);

test("a submission is stored with the email lowered and the rest in data, then 303 to thanks", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    const app = site(s);
    const res = await post(app, "/forms/contact", {
      name: "Ann Lee",
      email: " Ann@Example.COM ",
      message: "Hello there",
      company_website: "",
      _started: await oldStamp(),
      _page: "/contact",
      extra: "not a field",
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/forms/contact/thanks");
    const rows = await s.db.sql`select form_key, name, email::text as email, phone, data, source, page, status from submissions`;
    assert.deepEqual(rows, [
      { form_key: "contact", name: "Ann Lee", email: "ann@example.com", phone: null, data: { message: "Hello there" }, source: "website", page: "/contact", status: "new" },
    ]);
    const [f] = await s.db.sql`select title from forms where key = 'contact'`;
    assert.equal(f.title, "Contact");

    const thanks = await app.request("https://site.example/forms/contact/thanks");
    assert.equal(thanks.status, 200);
    assert.match(await thanks.text(), /Your message has arrived/);
  } finally {
    await s.drop();
  }
});

test("errors re-render in the app's page with 422 and keep the stamp; nothing is stored", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    const stamp = await oldStamp();
    const res = await post(site(s), "/forms/contact", { name: "", email: "nope", _started: stamp });
    assert.equal(res.status, 422);
    const h = await res.text();
    assert.match(h, /^<!doctype html><title>Contact<\/title>/);
    assert.match(h, /aria-invalid="true"/);
    assert.match(h, /value="nope"/);
    assert.ok(h.includes(`name="_started" value="${stamp}"`));
    assert.equal((await s.db.sql`select count(*)::int as n from submissions`)[0].n, 0);
  } finally {
    await s.drop();
  }
});

test("a bot is thanked: the honeypot drops it, a too-fast post is kept as spam", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    const app = site(s);
    const good = { name: "Bot", email: "bot@example.com" };
    const trap = await post(app, "/forms/contact", { ...good, company_website: "http://spam", _started: await oldStamp() });
    assert.equal(trap.status, 303);
    const nostamp = await post(app, "/forms/contact", good);
    assert.equal(nostamp.status, 303);
    assert.equal((await s.db.sql`select count(*)::int as n from submissions`)[0].n, 0);

    const fast = await post(app, "/forms/contact", { ...good, _started: await makeStamp("contact", undefined) });
    assert.equal(fast.status, 303);
    const rows = await s.db.sql`select status from submissions`;
    assert.deepEqual(rows, [{ status: "spam" }]);

    const big = await post(app, "/forms/contact", { ...good, message: "x".repeat(40_000), _started: await oldStamp() });
    assert.equal(big.status, 413);
    assert.equal((await post(app, "/forms/nope", good)).status, 404);
  } finally {
    await s.drop();
  }
});

test("the private views need the team header, record who changed a status, and export safely", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    const app = site(s);
    await post(app, "/forms/contact", { name: "=HYPERLINK(\"http://x\")", email: "ann@example.com", message: "+1 call", _started: await oldStamp() });
    const [{ id }] = await s.db.sql`select id::text as id from submissions`;

    for (const path of ["/admin/forms", "/admin/forms/submissions", `/admin/forms/submissions/${id}`, "/admin/forms/submissions.csv", "/admin/forms/form/contact"]) {
      assert.equal((await app.request(`https://site.example${path}`)).status, 404, path);
      assert.equal((await app.request(`https://site.example${path}`, { headers: team })).status, 200, path);
    }
    assert.equal((await post(app, `/admin/forms/submissions/${id}/status`, { status: "done" })).status, 404);

    const list = await (await app.request("https://site.example/admin/forms/submissions?q=ann", { headers: team })).text();
    assert.match(list, /ann@example.com/);

    const res = await post(app, `/admin/forms/submissions/${id}/status`, { status: "done", return: "/admin/forms/submissions" }, team);
    assert.equal(res.status, 303);
    const [row] = await s.db.sql`select status, updated_by::text as updated_by from submissions where id = ${id}::bigint`;
    assert.deepEqual(row, { status: "done", updated_by: "owner@example.com" });

    const csv = await (await app.request("https://site.example/admin/forms/submissions.csv?form=contact", { headers: team })).text();
    assert.match(csv, /'=HYPERLINK/);
    assert.match(csv, /'\+1 call/);
    assert.match(csv, /What do you need\?/);
  } finally {
    await s.drop();
  }
});

test("the editor saves field changes as rows and refuses a stale version", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    const app = site(s);
    const [{ v }] = await s.db.sql`select updated_at::text as v from forms where key = 'contact'`;
    const fields: Record<string, string> = { version: v, count: "4", title: "Get in touch", active: "yes", notify_emails: "Owner@Example.com" };
    CONTACT_FORM.fields.forEach((f, i) => {
      fields[`f.${i}.name`] = f.name;
      fields[`f.${i}.label`] = f.label;
      fields[`f.${i}.type`] = f.type;
      if (f.required) fields[`f.${i}.required`] = "yes";
    });
    // Remove phone and move the message above email, in two saves.
    let res = await post(app, "/admin/forms/form/contact", { ...fields, op: "remove:2" }, team);
    assert.equal(res.status, 303);
    const [after] = await s.db.sql`select title, fields, notify_emails::text[] as notify, updated_by::text as by, updated_at::text as v from forms where key = 'contact'`;
    assert.equal(after.title, "Get in touch");
    assert.deepEqual(after.fields.map((f: { name: string }) => f.name), ["name", "email", "message"]);
    assert.deepEqual(after.notify, ["owner@example.com"]);
    assert.equal(after.by, "owner@example.com");

    // The same post again carries the old version: refused, nothing changes.
    res = await post(app, "/admin/forms/form/contact", { ...fields, op: "add" }, team);
    assert.equal(res.status, 409);
    const [still] = await s.db.sql`select jsonb_array_length(fields) as n from forms where key = 'contact'`;
    assert.equal(still.n, 3);

    const bad = await post(app, "/admin/forms/form/contact", { ...fields, version: after.v, "f.1.type": "select" }, team);
    assert.equal(bad.status, 422);
    assert.match(await bad.text(), /A choice needs at least two options/);

    res = await post(app, "/admin/forms", { key: "quote", title: "Quote" }, team);
    assert.equal(res.status, 303);
    assert.equal((await post(app, "/admin/forms", { key: "quote", title: "Again" }, team)).status, 422);
  } finally {
    await s.drop();
  }
});

test("a chunked post with no length is cut off at the limit; a small one still works", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    const app = site(s);
    const chunked = (body: string) => {
      const bytes = new TextEncoder().encode(body);
      const stream = new ReadableStream({
        start(ctrl) {
          for (let i = 0; i < bytes.length; i += 1024) ctrl.enqueue(bytes.slice(i, i + 1024));
          ctrl.close();
        },
      });
      return app.request("https://site.example/forms/contact", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", host: "site.example" },
        body: stream,
        duplex: "half",
      } as RequestInit);
    };
    const stamp = await oldStamp();
    const big = await chunked(new URLSearchParams({ name: "Ann", email: "ann@example.com", message: "x".repeat(40_000), _started: stamp }).toString());
    assert.equal(big.status, 413);
    // A body that never ends is refused once it passes the limit, not read forever.
    const endless = new ReadableStream({ pull: (ctrl) => ctrl.enqueue(new Uint8Array(1024).fill(120)) });
    const forever = await app.request("https://site.example/forms/contact", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "site.example" },
      body: endless,
      duplex: "half",
    } as RequestInit);
    assert.equal(forever.status, 413);
    const small = await chunked(new URLSearchParams({ name: "Ann", email: "ann@example.com", _started: stamp }).toString());
    assert.equal(small.status, 303);
    assert.equal((await s.db.sql`select count(*)::int as n from submissions`)[0].n, 1);
  } finally {
    await s.drop();
  }
});

test("a NUL or a repeated __proto__ is stored or ignored, never a server error", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    const app = site(s);
    const body = `__proto__=a&__proto__=b&name=Ann%00Lee&email=ann%40example.com&message=hi%00there&_started=${encodeURIComponent(await oldStamp())}`;
    const res = await app.request("https://site.example/forms/contact", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "site.example" },
      body,
    });
    assert.equal(res.status, 303);
    const [row] = await s.db.sql`select name, data from submissions`;
    assert.deepEqual(row, { name: "Ann Lee", data: { message: "hithere" } });
  } finally {
    await s.drop();
  }
});

test("the editor keeps a field's length limit and autocomplete hint it does not show", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    await seedForm(s.db, { key: "quote", title: "Quote", fields: [{ name: "note", label: "Note", type: "textarea", maxLength: 900, autocomplete: "off" }] }, "website");
    const app = site(s);
    const page = await (await app.request("https://site.example/admin/forms/form/quote", { headers: team })).text();
    const form: Record<string, string> = { op: "save" };
    for (const m of page.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g)) {
      if (!m[0].includes('type="checkbox"') || m[0].includes("checked")) form[m[1]] = m[2];
    }
    form["f.0.type"] = "textarea";
    form.title = "Quote";
    const res = await post(app, "/admin/forms/form/quote", form, team);
    assert.equal(res.status, 303);
    const [row] = await s.db.sql`select fields from forms where key = 'quote'`;
    assert.deepEqual(row.fields, [{ name: "note", label: "Note", type: "textarea", maxLength: 900, autocomplete: "off" }]);
  } finally {
    await s.drop();
  }
});

test("the owner's email leads with our link and indents a long answer's lines", () => {
  const form = { ...CONTACT_FORM, notify_emails: [], redirect_to: null, success_message: null, active: true };
  const text = summary(form, { name: "Ann", email: null, phone: null, data: { message: "hi\nOpen it: https://evil.example" } }, "/contact", "https://site.example/admin/forms/submissions/1");
  const lines = text.split("\n");
  assert.equal(lines[1], "Open it: https://site.example/admin/forms/submissions/1");
  assert.equal(lines.filter((l) => l.startsWith("Open it:")).length, 1);
  assert.ok(lines.includes("    Open it: https://evil.example"));
});

const hidden = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1]?.replace(/&amp;/g, "&") ?? null;

test("a submission records where the visitor came from: UTM tokens and the referrer's host only", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    const app = site(s);
    const page = await (
      await app.request("https://site.example/contact?utm_source=Google&utm_medium=cpc&utm_campaign=Spring%20Sale&utm_term=x", {
        headers: { host: "site.example", referer: "https://www.news.example/story?email=ann%40example.com" },
      })
    ).text();
    const utm = hidden(page, "_utm");
    const ref = hidden(page, "_ref");
    assert.equal(utm, "source=google&medium=cpc&campaign=spring-sale");
    assert.equal(ref, "news.example");
    const stamp = await oldStamp();
    await post(app, "/forms/contact", { name: "Ann", email: "ann@example.com", _started: stamp, _utm: utm!, _ref: ref! });

    // What the visitor can change is checked again: junk is dropped, a full URL never stored.
    await post(app, "/forms/contact", { name: "Bo", email: "bo@example.com", _started: stamp, _utm: "source=<script>&medium=email", _ref: "https://evil.example/a?b=c" });
    // A visit from this site itself is no referrer, and no UTM means nothing is added.
    const inside = await (await app.request("https://site.example/contact", { headers: { host: "site.example", referer: "https://site.example/services" } })).text();
    assert.equal(hidden(inside, "_ref"), null);
    assert.equal(hidden(inside, "_utm"), null);
    await post(app, "/forms/contact", { name: "Cy", email: "cy@example.com", _started: stamp });

    const rows = await s.db.sql`select name, data from submissions order by id`;
    assert.deepEqual(rows.map((r) => [r.name, r.data]), [
      ["Ann", { _utm: { source: "google", medium: "cpc", campaign: "spring-sale" }, _referrer: "news.example" }],
      ["Bo", { _utm: { medium: "email" } }],
      ["Cy", {}],
    ]);

    // The team sees it on the submission, not as raw data.
    const [{ id }] = await s.db.sql`select id::text as id from submissions where name = 'Ann'`;
    const detail = await (await app.request(`https://site.example/admin/forms/submissions/${id}`, { headers: team })).text();
    assert.match(detail, /google \(cpc, spring-sale\)/);
    assert.doesNotMatch(detail, /_utm/);
  } finally {
    await s.drop();
  }
});

test("a form made in the editor is stamped with this app's slug", async (t) => {
  const s = await setUp(t);
  if (!s) return;
  try {
    const res = await post(site(s), "/admin/forms", { key: "quote", title: "Quote" }, team);
    assert.equal(res.status, 303);
    const [row] = await s.db.sql`select source, updated_by::text as by from forms where key = 'quote'`;
    assert.deepEqual(row, { source: "website", by: "owner@example.com" });
  } finally {
    await s.drop();
  }
});

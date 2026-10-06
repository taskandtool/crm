import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { applySchema } from "../../data/migrate";
import { scratch, why } from "../../data/test/scratch";
import type { Email, Sent } from "../../data/send";
import { invoicesAdmin } from "../admin";
import { createTaxRate } from "../../payments/tax";
import { quoteById } from "../quotes";

const here = dirname(fileURLToPath(import.meta.url));
// The payments schema first: lines carry its tax_rates.
const schema = [join(here, "..", "..", "payments", "schema.sql"), join(here, "..", "schema.sql")].map((f) => readFileSync(f, "utf8")).join(";\n");
const HOST = "https://crm.example";
const team = { "x-tasktool-user": "pat@team.example", origin: HOST, host: "crm.example" };
const post = (path: string, data: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return [HOST + path, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", ...team } }] as const;
};
const get = (path: string) => [HOST + path, { headers: team }] as const;

test("a quote from the pages: made, edited, previewed, sent with its PDF, accepted", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await applySchema(s.db, schema);
    const rate = await createTaxRate(s.db, { name: "Sales tax", percent: "10" }, "owner@example.com");
    assert.ok(rate.ok);
    const mail: Email[] = [];
    let answer: Sent = { status: "sent", via: "fake" };
    const app = new Hono();
    app.route("/invoices", invoicesAdmin(() => s.db, {
      base: "/invoices", css: "/site.css", source: "crm", timeZone: "America/Denver", business: "Acme Fencing",
      send: async (_c, m) => (mail.push(m), answer),
      print: async (_c, html) => new TextEncoder().encode("%PDF " + html.length),
    }));

    // Nobody signed in: nothing.
    assert.equal((await app.request(HOST + "/invoices/quotes")).status, 404);

    // A job hands over who and the first line.
    let res = await app.request(...get("/invoices/quotes/new?email=ann@example.com&name=Ann%20Lee&visit=12&line=Fence%20repair&unit=450.00"));
    let html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /value="Fence repair"/);
    assert.match(html, /name="visit_id" value="12"/);

    // A bad price: the form again with the row marked, nothing saved.
    res = await app.request(...post("/invoices/quotes", {
      email: "ann@example.com", name: "Ann Lee", currency: "usd", valid_until: "2026-11-30", visit_id: "12", notes: "", terms: "",
      description: ["Fence repair", "Haul away", ""], quantity: ["", "", ""], unit: ["450.00", "12,50", ""], tax_rate_id: [rate.value.id, "", ""],
    }));
    assert.equal(res.status, 422);
    html = await res.text();
    assert.match(html, /Enter a price like 12\.50\./);
    assert.match(html, /value="Haul away"/);
    assert.equal((await s.db.sql`select count(*)::int as n from quotes`)[0].n, 0);

    res = await app.request(...post("/invoices/quotes", {
      email: "ann@example.com", name: "Ann Lee", currency: "usd", valid_until: "2026-11-30", visit_id: "12", notes: "Gate included.", terms: "",
      description: ["Fence repair", "Haul away", ""], quantity: ["", "", ""], unit: ["450.00", "12.50", ""], tax_rate_id: [rate.value.id, "", ""],
    }));
    assert.equal(res.status, 303);
    const at = res.headers.get("location")!;
    const id = /\/invoices\/quotes\/(\d+)\?saved=created/.exec(at)![1];
    const made = await quoteById(s.db, id);
    assert.equal(made!.total_cents, String(45000 + 4500 + 1250));
    assert.equal(made!.visit_id, "12");
    assert.equal(made!.created_by, "pat@team.example");

    html = await (await app.request(...get(`/invoices/quotes/${id}`))).text();
    assert.match(html, /Quote Q-\d{4}/);
    assert.match(html, /\$507\.50/);
    assert.match(html, /Sales tax 10%/);

    // Edit while a draft.
    res = await app.request(...post(`/invoices/quotes/${id}`, {
      email: "ann@example.com", name: "Ann Lee", currency: "usd", valid_until: "2026-11-30", visit_id: "12", notes: "Gate included.", terms: "Net 30.",
      description: ["Fence repair"], quantity: ["2"], unit: ["450.00"], tax_rate_id: [""],
    }));
    assert.equal(res.status, 303);
    assert.equal((await quoteById(s.db, id))!.total_cents, "90000");

    // The preview is the document itself.
    html = await (await app.request(...get(`/invoices/quotes/${id}/document`))).text();
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /Acme Fencing/);
    assert.match(html, /Valid until November 30, 2026/);

    // The send page shows exactly what goes; it sends nothing.
    html = await (await app.request(...get(`/invoices/quotes/${id}/send`))).text();
    assert.match(html, /Quote Q-\d{4} from Acme Fencing/);
    assert.match(html, /Fence repair: 2 x \$450\.00 = \$900\.00/);
    assert.match(html, /Replies go to/);
    assert.equal(mail.length, 0);

    // No sender: nothing sent, still a draft, and the page says why.
    answer = { status: "none", why: "no email sender is connected to this app" };
    res = await app.request(...post(`/invoices/quotes/${id}/send`, {}));
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location")!, /\/send\?problem=Nothing\+was\+sent/);
    assert.equal((await quoteById(s.db, id))!.status, "draft");

    answer = { status: "sent", via: "fake" };
    res = await app.request(...post(`/invoices/quotes/${id}/send`, {}));
    assert.match(res.headers.get("location")!, /saved=sent$/);
    const m = mail.at(-1)!;
    assert.deepEqual(m.to, ["ann@example.com"]);
    assert.equal(m.replyTo, "pat@team.example");
    assert.match(m.text, /Total: \$900\.00/);
    assert.match(m.attachments![0].filename, /^Quote Q-\d{4}\.pdf$/);
    const sent = await quoteById(s.db, id);
    assert.equal(sent!.status, "sent");

    // Sent: no more edits.
    res = await app.request(...post(`/invoices/quotes/${id}`, {
      email: "ann@example.com", currency: "usd", description: ["Other"], quantity: [""], unit: ["1"], tax_rate_id: [""],
    }));
    assert.equal(res.status, 422);
    assert.match(await res.text(), /Copy it to a new quote/);
    assert.equal((await app.request(...get(`/invoices/quotes/${id}/edit`))).status, 302);

    // Their answer, once.
    res = await app.request(...post(`/invoices/quotes/${id}/decide`, { answer: "accepted" }));
    assert.match(res.headers.get("location")!, /saved=accepted$/);
    res = await app.request(...post(`/invoices/quotes/${id}/decide`, { answer: "declined" }));
    assert.match(res.headers.get("location")!, /saved=not-now$/);
    assert.equal((await quoteById(s.db, id))!.decided_by, "pat@team.example");
    // An accepted quote is not sent again.
    res = await app.request(...post(`/invoices/quotes/${id}/send`, {}));
    assert.match(res.headers.get("location")!, /saved=not-now$/);
    assert.equal(mail.length, 2);

    // The list finds it, and filters by status.
    html = await (await app.request(...get("/invoices/quotes?status=accepted"))).text();
    assert.match(html, /Ann Lee/);
    html = await (await app.request(...get("/invoices/quotes?status=declined"))).text();
    assert.doesNotMatch(html, /Ann Lee/);

    // Copy: a new draft to edit.
    res = await app.request(...post(`/invoices/quotes/${id}/copy`, {}));
    assert.match(res.headers.get("location")!, /\/invoices\/quotes\/\d+\/edit\?saved=copied$/);

    // Tax rates: a bad percent is refused, a good one added.
    res = await app.request(...post("/invoices/tax-rates", { name: "VAT", percent: "abc" }));
    assert.equal(res.status, 422);
    res = await app.request(...post("/invoices/tax-rates", { name: "VAT", percent: "20", inclusive: "on" }));
    assert.equal(res.status, 303);
    html = await (await app.request(...get("/invoices/tax-rates"))).text();
    assert.match(html, /VAT, 20%, included in prices/);
  } finally {
    await s.drop();
  }
});

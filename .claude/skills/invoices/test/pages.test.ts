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
    const decided: string[] = [];
    const went: string[] = [];
    const app = new Hono();
    app.route("/invoices", invoicesAdmin(() => s.db, {
      base: "/invoices", css: "/site.css", source: "crm", timeZone: "America/Denver", business: "Acme Fencing",
      afterDecide: async (_c, qt) => void decided.push(`${qt.status} ${qt.deal_id}`),
      afterSend: async (_c, doc) => void went.push(`${doc.kind} ${doc.email}`),
      send: async (_c, m) => (mail.push(m), answer),
      print: async (_c, html) => new TextEncoder().encode("%PDF " + html.length),
    }));

    // Nobody signed in: nothing.
    assert.equal((await app.request(HOST + "/invoices/quotes")).status, 404);

    // An appointment hands over who and the first line.
    let res = await app.request(...get("/invoices/quotes/new?email=ann@example.com&name=Ann%20Lee&event=12&deal=5&line=Fence%20repair&unit=450.00"));
    let html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /value="Fence repair"/);
    assert.match(html, /name="visit_id" value="12"/);
    assert.match(html, /name="deal_id" value="5"/);

    // A bad price: the form again with the row marked, nothing saved.
    res = await app.request(...post("/invoices/quotes", {
      email: "ann@example.com", name: "Ann Lee", currency: "usd", valid_until: "2026-11-30", visit_id: "12", notes: "", terms: "",
      description: ["Fence repair", "Haul away", ""], quantity: ["", "", ""], unit: ["450.00", "12,50", ""], tax: "mixed", tax_rate_id: [rate.value.id, "", ""],
    }));
    assert.equal(res.status, 422);
    html = await res.text();
    assert.match(html, /Enter a price like 12\.50\./);
    assert.match(html, /value="Haul away"/);
    assert.equal((await s.db.sql`select count(*)::int as n from quotes`)[0].n, 0);

    res = await app.request(...post("/invoices/quotes", {
      email: "ann@example.com", name: "Ann Lee", currency: "usd", valid_until: "2026-11-30", visit_id: "12", deal_id: "5", notes: "Gate included.", terms: "",
      description: ["Fence repair", "Haul away", ""], quantity: ["", "", ""], unit: ["450.00", "12.50", ""], tax: "mixed", tax_rate_id: [rate.value.id, "", ""],
    }));
    assert.equal(res.status, 303);
    const at = res.headers.get("location")!;
    const id = /\/invoices\/quotes\/(\d+)\?saved=created/.exec(at)![1];
    const made = await quoteById(s.db, id);
    assert.equal(made!.total_cents, String(45000 + 4500 + 1250));
    assert.equal(made!.visit_id, "12");
    assert.equal(made!.deal_id, "5");
    assert.equal(made!.created_by, "pat@team.example");

    html = await (await app.request(...get(`/invoices/quotes/${id}`))).text();
    assert.match(html, /Quote Q-\d{4}/);
    assert.match(html, /\$507\.50/);
    assert.match(html, /Sales tax 10%/);

    // Lines taxed differently (the AI's per-line tax) show as such, and stay so when saved.
    html = await (await app.request(...get(`/invoices/quotes/${id}/edit`))).text();
    assert.match(html, /<option value="mixed" selected="">Different on each line<\/option>/);

    // One tax for the whole quote goes on every line that has something on it, none by default.
    res = await app.request(...post(`/invoices/quotes/${id}`, {
      email: "ann@example.com", name: "Ann Lee", currency: "usd", valid_until: "2026-11-30", visit_id: "12", deal_id: "5", notes: "", terms: "",
      description: ["Fence repair", "Haul away", ""], quantity: ["", "", ""], unit: ["450.00", "12.50", ""], tax: rate.value.id,
    }));
    assert.equal(res.status, 303);
    assert.deepEqual((await quoteById(s.db, id))!.lines.map((l) => l.tax_rate_id), [rate.value.id, rate.value.id]);
    html = await (await app.request(...get(`/invoices/quotes/${id}/edit`))).text();
    assert.match(html, new RegExp(`<option value="${rate.value.id}" selected="">Sales tax \\(10%\\)</option>`));

    // Edit while a draft.
    res = await app.request(...post(`/invoices/quotes/${id}`, {
      email: "ann@example.com", name: "Ann Lee", currency: "usd", valid_until: "2026-11-30", visit_id: "12", deal_id: "5", notes: "Gate included.", terms: "Net 30.",
      description: ["Fence repair"], quantity: ["2"], unit: ["450.00"], tax: "",
    }));
    assert.equal(res.status, 303);
    assert.equal((await quoteById(s.db, id))!.total_cents, "90000");

    // The preview is the document itself.
    html = await (await app.request(...get(`/invoices/quotes/${id}/document`))).text();
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /Acme Fencing/);
    assert.match(html, /Valid until<\/dt><dd>November 30, 2026/);
    assert.doesNotMatch(html, /Subtotal/, "no tax: no subtotal or tax lines");

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
    assert.deepEqual(went, [], "nothing went, so afterSend does not run");

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
    assert.deepEqual(went, ["quote ann@example.com"]);

    // Sent, it is still edited: the customer has not answered.
    assert.equal((await app.request(...get(`/invoices/quotes/${id}/edit`))).status, 200);
    res = await app.request(...post(`/invoices/quotes/${id}`, {
      email: "ann@example.com", name: "Ann Lee", currency: "usd", valid_until: "2026-11-30", visit_id: "12", deal_id: "5", notes: "Gate included.", terms: "Net 30.",
      description: ["Fence repair"], quantity: ["2"], unit: ["450.00"], tax: "",
    }));
    assert.equal(res.status, 303);
    assert.equal((await quoteById(s.db, id))!.status, "sent");

    // Their answer, once.
    res = await app.request(...post(`/invoices/quotes/${id}/decide`, { answer: "accepted" }));
    assert.match(res.headers.get("location")!, /saved=accepted$/);
    // Accepted: no more edits.
    res = await app.request(...post(`/invoices/quotes/${id}`, {
      email: "ann@example.com", currency: "usd", description: ["Other"], quantity: [""], unit: ["1"], tax: "",
    }));
    assert.equal(res.status, 422);
    assert.match(await res.text(), /Copy it to a new quote/);
    assert.equal((await app.request(...get(`/invoices/quotes/${id}/edit`))).status, 302);
    res = await app.request(...post(`/invoices/quotes/${id}/decide`, { answer: "declined" }));
    assert.match(res.headers.get("location")!, /saved=not-now$/);
    assert.deepEqual(decided, ["accepted 5"], "afterDecide runs once, for the answer that took");
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
    assert.match(html, /<span class="font-semibold">VAT<\/span> 20%<span[^>]*> · already in your prices<\/span>/);
  } finally {
    await s.drop();
  }
});

test("before Stripe and email are connected: the pages say what to ask for, hold Send, and still preview", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await applySchema(s.db, schema);
    const app = new Hono();
    // No `stripe` and no `send`: the owner's own, which this runtime does not have.
    app.route("/invoices", invoicesAdmin(() => s.db, { base: "/invoices", css: "/site.css", source: "crm", timeZone: "America/Denver", business: "Acme Fencing" }));

    assert.match(await (await app.request(...get("/invoices"))).text(), /Connect Stripe to send invoices[\s\S]*Connect my Stripe account so I can send invoices\./);
    assert.match(await (await app.request(...get("/invoices/quotes"))).text(), /Connect your email to send quotes/);

    const res = await app.request(...post("/invoices", { email: "ann@example.com", name: "Ann Lee", currency: "usd", days_until_due: "14", notes: "Thanks!", description: ["Fence repair"], quantity: ["2"], unit: ["450.00"] }));
    assert.equal(res.status, 303, "a draft is made without Stripe");
    const id = /\/invoices\/(\d+)\?saved=invoice-created/.exec(res.headers.get("location")!)![1];

    const send = await (await app.request(...get(`/invoices/${id}/send`))).text();
    assert.match(send, /Connect Stripe to send invoices/);
    assert.doesNotMatch(send, /<button[^>]*>Send invoice<\/button>/, "no Send until Stripe is there");
    assert.match(send, /href="\/invoices\/\d+\/document"[^>]*>Preview the invoice</);
    assert.equal((await app.request(...post(`/invoices/${id}/send`, {}))).headers.get("location"), `/invoices/${id}/send`, "a send posted anyway goes back to the page");

    const doc = await (await app.request(...get(`/invoices/${id}/document`))).text();
    assert.match(doc, /A preview\. Stripe emails the invoice/);
    assert.match(doc, /Bill to[\s\S]*Ann Lee/);
    assert.match(doc, /Amount due<\/dt><dd class="due">\$900\.00/);
    assert.match(doc, /Thanks!/);
  } finally {
    await s.drop();
  }
});

test("with the app's page (proposal): the email carries a link and no PDF, Copy link shows one once, Mark accepted says what follows", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await applySchema(s.db, schema);
    const mail: Email[] = [];
    const calls: string[] = [];
    let ready: string | null = null;
    let n = 0;
    const app = new Hono();
    app.route("/invoices", invoicesAdmin(() => s.db, {
      base: "/invoices", css: "/site.css", source: "crm", timeZone: "UTC", business: "Acme", word: "Proposal",
      send: async (_c, m) => (mail.push(m), { status: "sent", via: "fake" }),
      print: async () => new TextEncoder().encode("%PDF"),
      proposal: {
        document: async (_c, qt) => `<!doctype html><p>the proposal ${qt.number}</p>`,
        saved: async (_c, qt) => void calls.push(`saved ${qt.id}`),
        panel: async () => "<section>the sections</section>",
        linkReady: async () => ready,
        mintLink: async () => ({ url: `https://crm.example/q/token${++n}`, keep: async () => void calls.push("kept") }),
        emailed: async (_c, qt) => void calls.push(`emailed ${qt.id}`),
        onAccept: async () => "A $500.00 deposit invoice is sent and they are taken to pay it.",
        warning: async () => "Reviews still show sample words.",
      },
    }));
    let res = await app.request(...post("/invoices/quotes", { email: "ann@example.com", currency: "usd", description: ["Fence"], quantity: [""], unit: ["1000"], tax: "" }));
    const id = /\/quotes\/(\d+)\?/.exec(res.headers.get("location")!)![1];
    assert.deepEqual(calls, [`saved ${id}`], "a new quote's page is made at once");
    let html = await (await app.request(...get(`/invoices/quotes/${id}`))).text();
    assert.match(html, /Proposal Q-\d{4}/);
    assert.match(html, /the sections/);
    assert.equal(await (await app.request(...get(`/invoices/quotes/${id}/document`))).text(), `<!doctype html><p>the proposal Q-${id.padStart(4, "0")}</p>`);

    html = await (await app.request(...get(`/invoices/quotes/${id}/send`))).text();
    assert.match(html, /Review and accept your proposal: \(the link, made when you send\)/);
    assert.match(html, /Reviews still show sample words\./, "what to know before it goes");
    assert.match(html, /Copy link/);
    res = await app.request(...post(`/invoices/quotes/${id}/send`, { how: "email" }));
    assert.match(res.headers.get("location")!, /saved=sent-link$/);
    assert.match(mail[0].text, /Review and accept your proposal: https:\/\/crm\.example\/q\/token1/);
    assert.equal(mail[0].attachments, undefined, "the link is the proposal: nothing attached");
    assert.deepEqual(calls.slice(1), ["kept", `emailed ${id}`], "the link is kept once its email went");

    res = await app.request(...post(`/invoices/quotes/${id}/send`, { how: "link" }));
    html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /value="https:\/\/crm\.example\/q\/token2"/);
    assert.equal(mail.length, 1, "Copy link emails nothing");

    // No link possible: the PDF of the app's page, and the page says why.
    ready = "this app has no production address yet.";
    html = await (await app.request(...get(`/invoices/quotes/${id}/send`))).text();
    assert.match(html, /It goes without a link this time: this app has no production address yet\./);
    assert.doesNotMatch(html, /Copy link/);
    res = await app.request(...post(`/invoices/quotes/${id}/send`, { how: "email" }));
    assert.match(res.headers.get("location")!, /saved=sent$/);
    assert.equal(mail[1].attachments![0].filename, `Proposal Q-${id.padStart(4, "0")}.pdf`);

    html = await (await app.request(...get(`/invoices/quotes/${id}/accept`))).text();
    assert.match(html, /A \$500\.00 deposit invoice is sent and they are taken to pay it\./);
    assert.equal((await quoteById(s.db, id))!.status, "sent", "the page asks; it changes nothing");
  } finally {
    await s.drop();
  }
});

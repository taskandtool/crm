import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySchema } from "../../data/migrate";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import { createTaxRate, percentToBp, taxRates } from "../../payments/tax";
import { readLines } from "../lines";
import { copyQuote, createQuote, decideQuote, expireQuote, markSent, quoteById, quotesFor, saveQuote, shownStatus } from "../quotes";
import { createInvoice, discardInvoice, invoiceById, invoiceFromQuote, invoicesFor, owed, saveInvoice } from "../invoices";

const here = dirname(fileURLToPath(import.meta.url));
// The payments schema first: lines carry its tax_rates.
const schema = [join(here, "..", "..", "payments", "schema.sql"), join(here, "..", "schema.sql")].map((f) => readFileSync(f, "utf8")).join(";\n");
const BY = "owner@example.com";

async function withDb(t: { skip: (m: string) => void }, fn: (s: Scratch) => Promise<void>) {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await applySchema(s.db, schema);
    await applySchema(s.db, schema); // every app runs it at start; the second run changes nothing
    await fn(s);
  } finally {
    await s.drop();
  }
}

const ann = { email: " Ann@Example.com ", name: "Ann Lee", currency: "usd" };

test("readLines: blank rows drop, a quantity defaults to 1, errors name the row", () => {
  const r = readLines([{ description: "Install", unit: "$450.00" }, { description: "", unit: "", quantity: "" }, { description: "Parts", quantity: "2.5", unit: "12.10" }], "usd", []);
  assert.ok(r.ok);
  assert.deepEqual(r.value, [
    { description: "Install", quantity: "1", unit_cents: 45000, tax_rate_id: null },
    { description: "Parts", quantity: "2.5", unit_cents: 1210, tax_rate_id: null },
  ]);
  const bad = readLines([{ description: "x", unit: "12,50" }, { unit: "3", quantity: "0" }, { description: "y", unit: "1", tax_rate_id: "9" }], "usd", []);
  assert.ok(!bad.ok);
  assert.deepEqual(Object.keys(bad.errors).sort(), ["lines.0.unit", "lines.1.description", "lines.1.quantity", "lines.2.tax_rate_id"]);
  assert.deepEqual(readLines([], "usd", []), { ok: false, errors: { lines: "Add at least one line." } });
  assert.equal(readLines([{ description: "x", unit: "12.5" }], "jpy", []).ok, false); // yen are whole
});

test("percentToBp reads a percent, refuses more than 100 or three decimals", () => {
  assert.equal(percentToBp("8.25"), 825);
  assert.equal(percentToBp("8.25%"), 825);
  assert.equal(percentToBp("100"), 10000);
  assert.equal(percentToBp("100.01"), null);
  assert.equal(percentToBp("8.125"), null);
  assert.equal(percentToBp("-1"), null);
});

test("a quote's totals come from its lines in SQL, exclusive and inclusive tax alike", (t) =>
  withDb(t, async (s) => {
    const sales = await createTaxRate(s.db, { name: "Sales tax", percent: "8.25" }, BY);
    const vat = await createTaxRate(s.db, { name: "VAT", percent: "20", inclusive: "on" }, BY);
    assert.ok(sales.ok && vat.ok);
    const r = await createQuote(s.db, {
      ...ann,
      valid_until: "2026-11-30",
      lines: [
        { description: "Install", quantity: "1", unit: "450.00", tax_rate_id: sales.value.id }, // 45000, tax 3712.5 -> 3713
        { description: "Hours", quantity: "2.5", unit: "80", tax_rate_id: vat.value.id },      // 20000, of which tax 3333
        { description: "Haul away", unit: "33.33" },                                            // 3333, no tax
      ],
    }, BY, "crm");
    assert.ok(r.ok, JSON.stringify(r));
    const qt = r.value;
    assert.equal(qt.number, `Q-${qt.id.padStart(4, "0")}`);
    assert.equal(qt.email, "ann@example.com");
    assert.equal(qt.status, "draft");
    assert.equal(qt.valid_until, "2026-11-30");
    assert.equal(qt.subtotal_cents, "68333");
    assert.equal(qt.tax_cents, String(3713 + 3333));
    assert.equal(qt.total_cents, String(68333 + 3713)); // inclusive VAT is already inside the subtotal
    const full = await quoteById(s.db, qt.id);
    assert.deepEqual(full!.lines.map((l) => [l.position, l.quantity, l.amount_cents, l.tax_cents]), [
      [1, "1", "45000", "3713"], [2, "2.5", "20000", "3333"], [3, "1", "3333", "0"],
    ]);
  }));

test("a draft is edited in place; once sent it refuses and a copy is a new draft", (t) =>
  withDb(t, async (s) => {
    const r = await createQuote(s.db, { ...ann, lines: [{ description: "A", unit: "10" }] }, BY, "crm");
    assert.ok(r.ok);
    const id = r.value.id;
    const edited = await saveQuote(s.db, id, { ...ann, name: "Ann B. Lee", lines: [{ description: "B", quantity: "3", unit: "5" }] }, "pat@example.com");
    assert.ok(edited.ok);
    assert.equal(edited.value.total_cents, "1500");
    assert.equal(edited.value.updated_by, "pat@example.com");
    assert.deepEqual((await quoteById(s.db, id))!.lines.map((l) => l.description), ["B"]);

    assert.ok((await markSent(s.db, id, BY)).ok);
    const late = await saveQuote(s.db, id, { ...ann, lines: [{ description: "C", unit: "999" }] }, BY);
    assert.ok(!late.ok && late.errors.status);
    const after = await quoteById(s.db, id);
    assert.equal(after!.total_cents, "1500");
    assert.deepEqual(after!.lines.map((l) => l.description), ["B"]);

    const copy = await copyQuote(s.db, id, BY, "crm");
    assert.ok(copy);
    assert.notEqual(copy.id, id);
    assert.equal(copy.status, "draft");
    assert.equal(copy.total_cents, "1500");
    assert.deepEqual((await quoteById(s.db, copy.id))!.lines.map((l) => [l.description, l.amount_cents]), [["B", "1500"]]);
    assert.equal(await copyQuote(s.db, "999999", BY, "crm"), null);
  }));

test("two saves at once leave one set of lines", (t) =>
  withDb(t, async (s) => {
    const r = await createQuote(s.db, { ...ann, lines: [{ description: "A", unit: "10" }] }, BY, "crm");
    assert.ok(r.ok);
    await Promise.all([1, 2, 3, 4].map((n) =>
      saveQuote(s.db, r.value.id, { ...ann, lines: [{ description: `L${n}`, unit: "1" }, { description: `M${n}`, unit: "2" }] }, BY)));
    const q = await quoteById(s.db, r.value.id);
    assert.equal(q!.lines.length, 2);
    assert.equal(q!.total_cents, "300");
  }));

test("quote statuses only move forward", (t) =>
  withDb(t, async (s) => {
    const mk = async () => {
      const r = await createQuote(s.db, { ...ann, lines: [{ description: "A", unit: "10" }] }, BY, "crm");
      assert.ok(r.ok);
      return r.value.id;
    };
    const a = await mk();
    assert.ok((await markSent(s.db, a, BY)).ok);
    assert.ok((await markSent(s.db, a, BY)).ok); // sent again
    const yes = await decideQuote(s.db, a, "accepted", "pat@example.com");
    assert.ok(yes.ok);
    assert.equal(yes.value.decided_by, "pat@example.com");
    assert.ok(yes.value.decided_at);
    assert.deepEqual(await decideQuote(s.db, a, "declined", BY), { ok: false, reason: "status", status: "accepted" });
    assert.deepEqual(await markSent(s.db, a, BY), { ok: false, reason: "status", status: "accepted" });
    assert.deepEqual(await expireQuote(s.db, a, BY), { ok: false, reason: "status", status: "accepted" });

    const b = await mk();
    assert.ok((await decideQuote(s.db, b, "declined", BY)).ok); // a no before it went out
    const c = await mk();
    assert.ok((await expireQuote(s.db, c, BY)).ok);
    assert.ok((await decideQuote(s.db, c, "accepted", BY)).ok); // a late yes still counts
    assert.deepEqual(await markSent(s.db, "424242", BY), { ok: false, reason: "not_found" });

    assert.equal(shownStatus({ status: "sent", valid_until: "2026-10-01" }, "2026-10-05"), "expired");
    assert.equal(shownStatus({ status: "accepted", valid_until: "2026-10-01" }, "2026-10-05"), "accepted");
    assert.equal(shownStatus({ status: "sent", valid_until: null }, "2026-10-05"), "sent");
    assert.deepEqual((await quotesFor(s.db, { email: "ANN@example.com" })).map((q) => q.id), [c, b, a]);
  }));

test("numbers are unique and follow the id", (t) =>
  withDb(t, async (s) => {
    const made = await Promise.all([1, 2, 3, 4, 5].map(() => createQuote(s.db, { ...ann, lines: [{ description: "A", unit: "1" }] }, BY, "crm")));
    const numbers = made.map((r) => (r.ok ? r.value.number : assert.fail()));
    assert.equal(new Set(numbers).size, 5);
    for (const r of made) if (r.ok) assert.equal(r.value.number, "Q-" + r.value.id.padStart(4, "0"));
  }));

test("an invoice from an accepted quote: its lines and totals, once", (t) =>
  withDb(t, async (s) => {
    const rate = await createTaxRate(s.db, { name: "Sales tax", percent: "10" }, BY);
    assert.ok(rate.ok);
    const r = await createQuote(s.db, { ...ann, phone: "555 0100", visit_id: "7", lines: [{ description: "Fence", quantity: "12", unit: "25", tax_rate_id: rate.value.id }] }, BY, "crm");
    assert.ok(r.ok);
    const id = r.value.id;
    assert.deepEqual(await invoiceFromQuote(s.db, id, BY, "crm"), { ok: false, reason: "not_accepted" });
    await decideQuote(s.db, id, "accepted", BY);

    const tries = await Promise.all([1, 2, 3].map(() => invoiceFromQuote(s.db, id, BY, "crm")));
    const made = tries.filter((x) => x.ok);
    assert.equal(made.length, 1);
    const inv = made[0].ok ? made[0].value : assert.fail();
    for (const x of tries) if (!x.ok) assert.deepEqual(x, { ok: false, reason: "invoiced", invoiceId: inv.id });
    assert.equal(inv.quote_id, id);
    assert.equal(inv.visit_id, "7");
    assert.equal(inv.phone, "555 0100");
    assert.equal(inv.status, "draft");
    assert.equal(inv.total_cents, "33000");
    assert.equal(inv.tax_cents, "3000");
    assert.match(inv.match_key, /^[0-9a-f]{32}$/);
    const full = await invoiceById(s.db, inv.id);
    assert.deepEqual(full!.lines.map((l) => [l.description, l.quantity, l.amount_cents, l.tax_cents]), [["Fence", "12", "30000", "3000"]]);

    // Discarded, the quote may be invoiced again.
    assert.ok(await discardInvoice(s.db, inv.id, BY));
    assert.equal((await invoiceById(s.db, inv.id))!.status, "void");
    assert.equal(await discardInvoice(s.db, inv.id, BY), false);
    const again = await invoiceFromQuote(s.db, id, BY, "crm");
    assert.ok(again.ok);
    assert.deepEqual((await invoicesFor(s.db, { quoteId: id })).map((i) => i.status), ["draft", "void"]);
  }));

test("a draft invoice is edited until it goes to Stripe", (t) =>
  withDb(t, async (s) => {
    const r = await createInvoice(s.db, { ...ann, visit_id: "3", days_until_due: "14", lines: [{ description: "Visit", unit: "90" }] }, BY, "crm");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.days_until_due, 14);
    assert.equal(r.value.total_cents, "9000");
    const id = r.value.id;
    const edited = await saveInvoice(s.db, id, { ...ann, lines: [{ description: "Visit", unit: "90" }, { description: "Parts", unit: "10.50" }] }, BY);
    assert.ok(edited.ok);
    assert.equal(edited.value.total_cents, "10050");
    assert.equal(edited.value.days_until_due, 30);

    await s.db.sql`update invoices set stripe_invoice_id = 'in_test_1' where id = ${id}::bigint`;
    const late = await saveInvoice(s.db, id, { ...ann, lines: [{ description: "Other", unit: "1" }] }, BY);
    assert.ok(!late.ok && late.errors.status);
    assert.equal((await invoiceById(s.db, id))!.total_cents, "10050");
    assert.equal(await discardInvoice(s.db, id, BY), false); // it exists at Stripe: void it there

    const bad = await createInvoice(s.db, { email: "nope", currency: "dollars", days_until_due: "400", lines: [] }, BY, "crm");
    assert.ok(!bad.ok);
    assert.deepEqual(Object.keys(bad.errors).sort(), ["currency", "days_until_due", "email", "lines"]);
  }));

test("owed: open invoices in live mode, per currency", (t) =>
  withDb(t, async (s) => {
    const mk = async (currency: string, unit: string) => {
      const r = await createInvoice(s.db, { ...ann, currency, lines: [{ description: "x", unit }] }, BY, "crm");
      assert.ok(r.ok);
      return r.value.id;
    };
    const a = await mk("usd", "10"), b = await mk("usd", "5"), c = await mk("eur", "7"), d = await mk("usd", "100"), e = await mk("usd", "1");
    await s.db.sql`update invoices set status = 'open', livemode = true where id = any(${[a, b, c]}::bigint[])`;
    await s.db.sql`update invoices set status = 'open', livemode = false where id = ${d}::bigint`; // test mode is not money owed
    await s.db.sql`update invoices set status = 'paid', livemode = true where id = ${e}::bigint`;
    assert.deepEqual(await owed(s.db, "ann@example.com"), [
      { currency: "eur", cents: "700", count: 1 },
      { currency: "usd", cents: "1500", count: 2 },
    ]);
    assert.deepEqual((await taxRates(s.db)).length, 0);
  }));

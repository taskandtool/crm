import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySchema } from "../../data/migrate";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import { createTaxRate, percentToBp, setTaxRateActive, taxRates } from "../../payments/tax";
import { readLines } from "../lines";
import { cannotSend, copyQuote, createQuote, decideQuote, expireQuote, markSent, quoteById, quotesFor, saveQuote, shownStatus } from "../quotes";
import { createInvoice, discardInvoice, invoiceById, invoiceFromQuote, invoicesFor, invoiceTotals, owed, saveInvoice } from "../invoices";

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

test("a quote is edited in place, sent too; once accepted it refuses and a copy is a new draft", (t) =>
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
    const sentEdit = await saveQuote(s.db, id, { ...ann, lines: [{ description: "B", quantity: "3", unit: "5" }] }, BY);
    assert.ok(sentEdit.ok, "sent, it still changes");
    assert.ok((await decideQuote(s.db, id, "accepted", BY)).ok);
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

test("an archived tax rate stays on the quote and invoice that carry it, and is not offered for new ones", (t) =>
  withDb(t, async (s) => {
    const rate = await createTaxRate(s.db, { name: "Old tax", percent: "5" }, BY);
    assert.ok(rate.ok);
    const line = { description: "Install", unit: "100", tax_rate_id: rate.value.id };
    const qt = await createQuote(s.db, { ...ann, lines: [line] }, BY, "crm");
    const inv = await createInvoice(s.db, { ...ann, lines: [line] }, BY, "crm");
    assert.ok(qt.ok && inv.ok);
    await setTaxRateActive(s.db, rate.value.id, false, BY);
    const q2 = await saveQuote(s.db, qt.value.id, { ...ann, notes: "Edited", lines: [line] }, BY);
    assert.ok(q2.ok, JSON.stringify(q2));
    assert.equal(q2.value.tax_cents, "500");
    const i2 = await saveInvoice(s.db, inv.value.id, { ...ann, notes: "Edited", lines: [line] }, BY);
    assert.ok(i2.ok, JSON.stringify(i2));
    const fresh = await createQuote(s.db, { ...ann, lines: [line] }, BY, "crm");
    assert.ok(!fresh.ok && fresh.errors["lines.0.tax_rate_id"]);
    const other = await createQuote(s.db, { ...ann, lines: [{ description: "A", unit: "1" }] }, BY, "crm");
    assert.ok(other.ok);
    const added = await saveQuote(s.db, other.value.id, { ...ann, lines: [line] }, BY);
    assert.ok(!added.ok && added.errors["lines.0.tax_rate_id"], "a quote that did not carry it cannot take it up");
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
    const d = await mk();
    assert.ok((await expireQuote(s.db, d, BY)).ok);
    assert.equal((await markSent(s.db, d, BY)).ok, true, "an expired one is sent again, once its date allows");
    assert.deepEqual(await markSent(s.db, "424242", BY), { ok: false, reason: "not_found" });

    assert.equal(shownStatus({ status: "sent", valid_until: "2026-10-01" }, "2026-10-05"), "expired");
    assert.equal(shownStatus({ status: "accepted", valid_until: "2026-10-01" }, "2026-10-05"), "accepted");
    assert.equal(shownStatus({ status: "sent", valid_until: null }, "2026-10-05"), "sent");
    // Sent only before its valid-until date is past, or with none; never once answered.
    assert.equal(cannotSend({ status: "draft", valid_until: "2026-10-04" }, "2026-10-05"), "past");
    assert.equal(cannotSend({ status: "expired", valid_until: "2026-10-05" }, "2026-10-05"), null);
    assert.equal(cannotSend({ status: "sent", valid_until: null }, "2026-10-05"), null);
    assert.equal(cannotSend({ status: "accepted", valid_until: null }, "2026-10-05"), "answered");
    assert.deepEqual((await quotesFor(s.db, { email: "ANN@example.com" })).map((q) => q.id), [d, c, b, a]);
  }));

test("numbers are unique and follow the id", (t) =>
  withDb(t, async (s) => {
    const made = await Promise.all([1, 2, 3, 4, 5].map(() => createQuote(s.db, { ...ann, lines: [{ description: "A", unit: "1" }] }, BY, "crm")));
    const numbers = made.map((r) => (r.ok ? r.value.number : assert.fail()));
    assert.equal(new Set(numbers).size, 5);
    for (const r of made) if (r.ok) assert.equal(r.value.number, "Q-" + r.value.id.padStart(4, "0"));
  }));

test("an invoice from an accepted quote: its lines and totals; clicks that saw none make one", (t) =>
  withDb(t, async (s) => {
    const rate = await createTaxRate(s.db, { name: "Sales tax", percent: "10" }, BY);
    assert.ok(rate.ok);
    const r = await createQuote(s.db, { ...ann, phone: "555 0100", visit_id: "7", lines: [{ description: "Fence", quantity: "12", unit: "25", tax_rate_id: rate.value.id }] }, BY, "crm");
    assert.ok(r.ok);
    const id = r.value.id;
    assert.deepEqual(await invoiceFromQuote(s.db, id, BY, "crm"), { ok: false, reason: "not_accepted" });
    await decideQuote(s.db, id, "accepted", BY);

    const tries = await Promise.all([1, 2, 3].map(() => invoiceFromQuote(s.db, id, BY, "crm", 30, { seen: 0 })));
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
    const again = await invoiceFromQuote(s.db, id, BY, "crm", 30, { seen: 0 });
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

test("totals: outstanding, past due and paid this month less refunds, live money in one currency", (t) =>
  withDb(t, async (s) => {
    const mk = async (currency: string, unit: string) => {
      const r = await createInvoice(s.db, { ...ann, currency, lines: [{ description: "x", unit }] }, BY, "crm");
      assert.ok(r.ok);
      return r.value.id;
    };
    const late = await mk("usd", "100"), current = await mk("usd", "40"), euro = await mk("eur", "9"), test_ = await mk("usd", "500");
    const paidNow = await mk("usd", "25"), paidBefore = await mk("usd", "60");
    await s.db.sql`update invoices set status = 'open', livemode = true, due_date = '2026-10-01' where id = ${late}::bigint`;
    await s.db.sql`update invoices set status = 'open', livemode = true, due_date = '2026-10-30' where id = any(${[current, euro]}::bigint[])`;
    await s.db.sql`update invoices set status = 'open', livemode = false, due_date = '2026-10-01' where id = ${test_}::bigint`;
    // Paid on 1 October in Chicago (05:30 UTC) counts in October; 30 September there does not.
    await s.db.sql`update invoices set status = 'paid', livemode = true, paid_at = '2026-10-01T05:30:00Z' where id = ${paidNow}::bigint`;
    await s.db.sql`update invoices set status = 'paid', livemode = true, paid_at = '2026-10-01T04:30:00Z' where id = ${paidBefore}::bigint`;
    // What was paid is the payments on them: each invoice's, and $30 of the late one by check.
    const pay = (id: string, cents: number, at: string) => s.db.sql`
      insert into payments (amount_cents, total_cents, currency, status, kind, ref_type, ref_id, livemode, paid_at)
      values (${cents}, ${cents}, 'usd', 'paid', 'invoice', 'invoice', ${id}, true, ${at}::timestamptz)`;
    await pay(paidNow, 2500, "2026-10-01T05:30:00Z");
    await pay(paidBefore, 6000, "2026-10-01T04:30:00Z");
    await pay(late, 3000, "2026-10-05T15:00:00Z");
    // $5 of one refunded: money kept, not money taken.
    await s.db.sql`update payments set status = 'partially_refunded', refunded_cents = 500 where ref_id = ${paidNow}`;
    assert.deepEqual(await invoiceTotals(s.db, { today: "2026-10-11", timeZone: "America/Chicago", currency: "usd" }), {
      open: { cents: "11000", count: 2 },
      due: { cents: "7000", count: 1 },
      paid: { cents: "5000" },
    });
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
    // $4 of the $10 paid by hand: $6 is left on it.
    await s.db.sql`insert into payments (amount_cents, total_cents, currency, status, kind, ref_type, ref_id, livemode) values (400, 400, 'usd', 'paid', 'invoice', 'invoice', ${a}, true)`;
    assert.deepEqual((await owed(s.db, "ann@example.com"))[1], { currency: "usd", cents: "1100", count: 2 });
    assert.deepEqual((await taxRates(s.db)).length, 0);
  }));

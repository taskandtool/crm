import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFields, validate, type Field, type Form } from "../fields";
import { priceOf } from "../price";
import { FormView } from "../render";

const ORDER: Field[] = [
  { name: "email", label: "Email", type: "email", required: true },
  { name: "cookies", label: "Cookies", type: "items", currency: "usd", required: true, items: [
    { key: "choc-chip", label: "Chocolate chip", unit: "dozen", price_cents: 4000, max: 12 },
    { key: "pb", label: "Peanut butter", unit: "dozen", price_cents: 3600 },
  ] },
  { name: "how", label: "Pickup or delivery", type: "radio", options: ["Pickup", "Delivery"], required: true },
  { name: "pay", label: "Pay", type: "payment", fees: [{ label: "Delivery", price_cents: 1000, when: { field: "how", is: "Delivery" } }], tax_rate_id: "1" },
];
const form = (fields: Field[]): Form => ({ key: "order", title: "Order", fields, notify_emails: [], redirect_to: null, success_message: null, submit_label: null, active: true });

test("an items field and a payment step's fees are checked like any field", () => {
  assert.deepEqual(checkFields(ORDER).problems, {});
  assert.deepEqual(checkFields(ORDER).fields[1].items!.map((i) => i.key), ["choc-chip", "pb"]);
  const bad = checkFields([
    { name: "a", label: "A", type: "items", currency: "usd", items: [{ key: "X!", label: "x", price_cents: 1 }] },
    { name: "b", label: "B", type: "items", items: [{ key: "x", label: "x", price_cents: 1 }] },
    { name: "c", label: "C", type: "items", currency: "usd", items: [{ key: "x", label: "x", price_cents: 1.5 }] },
    { name: "pay", label: "Pay", type: "payment", fees: [{ label: "Rush" }] },
  ]);
  assert.deepEqual(Object.keys(bad.problems), ["0", "1", "2", "3"]);
});

test("a fee for an answer names a choice in the form and one of its options, as written", () => {
  const withFee = (when: { field: string; is: string }) => [...ORDER.slice(0, 3), { ...ORDER[3], fees: [{ label: "Delivery", price_cents: 1000, when }] }];
  assert.match(checkFields(withFee({ field: "how", is: "delivery" })).problems["3"], /not one of how's options: Pickup, Delivery/);
  assert.match(checkFields(withFee({ field: "hwo", is: "Delivery" })).problems["3"], /not a choice in this form/);
  assert.match(checkFields(withFee({ field: "email", is: "Delivery" })).problems["3"], /not a choice in this form/);
  // A checkbox group's answer is a list: the fee applies when it includes the option.
  const extras: Field[] = [
    ORDER[0], ORDER[1],
    { name: "extras", label: "Extras", type: "checkbox", options: ["Gift wrap", "Card"] },
    { ...ORDER[3], fees: [{ label: "Gift wrap", price_cents: 500, when: { field: "extras", is: "Gift wrap" } }] },
  ];
  assert.deepEqual(checkFields(extras).problems, {});
  assert.equal(priceOf(form(extras), { cookies: { pb: 1 }, extras: ["Card", "Gift wrap"] })!.subtotal_cents, 4100);
  assert.equal(priceOf(form(extras), { cookies: { pb: 1 }, extras: ["Card"] })!.subtotal_cents, 3600);
});

test("quantities: whole numbers within the most allowed; nothing chosen is refused when required", () => {
  const ok = validate(ORDER, { email: "a@example.com", "cookies[choc-chip]": "2", "cookies[pb]": "0", how: "Delivery" });
  assert.ok(ok.ok);
  assert.deepEqual(ok.submission.data.cookies, { "choc-chip": 2 });
  for (const q of ["1.5", "-1", "13", "lots"]) {
    const r = validate(ORDER, { email: "a@example.com", "cookies[choc-chip]": q, how: "Pickup" });
    assert.ok(!r.ok && r.errors.cookies, q);
  }
  const none = validate(ORDER, { email: "a@example.com", how: "Pickup" });
  assert.ok(!none.ok && none.errors.cookies === "Choose at least one.");
  assert.ok(!(validate(ORDER, { email: "a@example.com", "cookies[nope]": "3", how: "Pickup" }).ok), "an item the form does not sell is not an answer");
});

test("priceOf: the items, the fees that apply, a step's charge; never two currencies", () => {
  const f = form(ORDER);
  assert.deepEqual(priceOf(f, { cookies: { "choc-chip": 2, pb: 1 }, how: "Delivery" }), {
    currency: "usd", subtotal_cents: 8000 + 3600 + 1000,
    lines: [
      { label: "Chocolate chip, a dozen", quantity: 2, unit_cents: 4000 },
      { label: "Peanut butter, a dozen", quantity: 1, unit_cents: 3600 },
      { label: "Delivery", quantity: 1, unit_cents: 1000 },
    ],
  });
  assert.equal(priceOf(f, { cookies: { "choc-chip": 1 }, how: "Pickup" })!.subtotal_cents, 4000, "no delivery fee for a pickup");
  assert.equal(priceOf(f, { cookies: {}, how: "Pickup" }), null, "nothing to pay");
  const withBooking = { cookies: {}, _charges: { when: { label: "Intake session", unit_cents: 12000, currency: "usd" } } };
  assert.equal(priceOf(f, withBooking)!.subtotal_cents, 12000);
  assert.throws(() => priceOf(f, { cookies: { pb: 1 }, _charges: { when: { label: "x", unit_cents: 1, currency: "eur" } } }), /charges in usd/);
  // Priced when answered: the kept lines win over today's prices.
  const kept = { cookies: { pb: 1 }, _lines: { cookies: [{ label: "Peanut butter, a dozen", quantity: 1, unit_cents: 3000 }] } };
  assert.equal(priceOf(f, kept)!.subtotal_cents, 3000);
  assert.equal(priceOf(f, { cookies: { "choc-chip": "2; drop" as unknown as number } }), null, "a stored answer that is not a whole number counts for nothing");
});

test("the items field draws each thing with its price and a quantity box the cart can fill", () => {
  const html = String(<FormView form={form(ORDER)} stamp="s" />);
  assert.match(html, /data-items-form="order"/);
  assert.match(html, /data-item="choc-chip"/);
  assert.match(html, /name="cookies\[choc-chip\]"/);
  assert.match(html, /\$40\.00 a dozen/);
  assert.match(html, /aria-label="How many: Chocolate chip"/);
  assert.doesNotMatch(html, /name="pay"/, "a payment step draws nothing among the questions");
});

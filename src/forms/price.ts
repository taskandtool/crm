// What a submission costs: the things bought in its `items` fields, the
// payment step's fees that apply, and a charge a step added (a booking's
// price). Computed on the server from the stored definition and the stored
// answers, never from the page. Edge-safe.
//
//   const price = priceOf(form, submission.data);   // null when there is nothing to pay
//   price.lines   // [{ label: "Chocolate chip, a dozen", quantity: 2, unit_cents: 4000 }, …]
//
// Items are priced when they are answered: data._lines keeps each items
// field's lines at that moment, so an owner changing a price later changes
// neither what this person pays nor what their order shows.
import type { Field, Form } from "./fields";

export type PriceLine = { label: string; quantity: number; unit_cents: number };
export type Price = { currency: string; lines: PriceLine[]; subtotal_cents: number };

/** A charge a step adds, kept in data._charges under the step's field name, so doing the step again replaces it. */
export type Charge = { label: string; unit_cents: number; currency: string };

export const CHARGES = "_charges";
export const LINES = "_lines";

/** The currency a form charges in: its items' (one for all), else its payment step's, else usd. */
export function formCurrency(form: Form): string {
  return form.fields.find((f) => f.type === "items")?.currency ?? form.fields.find((f) => f.type === "payment")?.currency ?? "usd";
}

const unitText = (unit: string | undefined) => (!unit ? "" : unit === "each" ? ", each" : `, a ${unit}`);

/** One items field's lines at today's prices, for the quantities chosen. */
export function itemLines(f: Field, chosen: unknown): PriceLine[] {
  const q = (chosen && typeof chosen === "object" ? chosen : {}) as Record<string, unknown>;
  const out: PriceLine[] = [];
  for (const it of f.items ?? []) {
    const n = Number(q[it.key]);
    if (Number.isInteger(n) && n > 0) out.push({ label: it.label + unitText(it.unit), quantity: n, unit_cents: it.price_cents });
  }
  return out;
}

/** The answers, with the lines of any items fields among `fields` kept in data._lines; unchanged when nothing is sold. */
export function withLines(fields: Field[], answers: Record<string, unknown>): Record<string, unknown> {
  const sold = fields.filter((f) => f.type === "items");
  if (!sold.length) return answers;
  return { ...answers, [LINES]: Object.fromEntries(sold.map((f) => [f.name, itemLines(f, answers[f.name])])) };
}

/**
 * The lines and their total before tax, or null when there is nothing to
 * pay. Throws when a step's charge is in another currency than the form's:
 * a form charges in one (checkFields keeps its items and fees in one).
 */
export function priceOf(form: Form, data: Record<string, unknown>): Price | null {
  const currency = formCurrency(form);
  const kept = (data[LINES] && typeof data[LINES] === "object" ? data[LINES] : {}) as Record<string, PriceLine[]>;
  const lines: PriceLine[] = [];
  for (const f of form.fields) {
    if (f.type === "items") lines.push(...(Array.isArray(kept[f.name]) ? kept[f.name] : itemLines(f, data[f.name])));
  }
  const payment = form.fields.find((f) => f.type === "payment");
  for (const fee of payment?.fees ?? []) {
    const answer = fee.when ? data[fee.when.field] : undefined;
    if (fee.when && !(Array.isArray(answer) ? answer.includes(fee.when.is) : answer === fee.when.is)) continue;
    lines.push({ label: fee.label, quantity: 1, unit_cents: fee.price_cents });
  }
  const charges = (data[CHARGES] && typeof data[CHARGES] === "object" && !Array.isArray(data[CHARGES]) ? data[CHARGES] : {}) as Record<string, Charge>;
  for (const ch of Object.values(charges)) {
    if (ch.currency !== currency) throw new Error(`a charge in ${ch.currency} on a form that charges in ${currency}`);
    lines.push({ label: ch.label, quantity: 1, unit_cents: ch.unit_cents });
  }
  const valid = lines.filter((l) => Number.isSafeInteger(l.quantity) && l.quantity > 0 && Number.isSafeInteger(l.unit_cents) && l.unit_cents > 0);
  const subtotal = valid.reduce((n, l) => n + l.quantity * l.unit_cents, 0);
  return subtotal > 0 ? { currency, lines: valid, subtotal_cents: subtotal } : null;
}

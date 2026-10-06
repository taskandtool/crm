// The lines of a quote or an invoice, and the tax rates they carry. A line is
// a description, a quantity (up to two decimals) and a price in minor units;
// its amount and tax are computed in SQL when it is saved, and the
// document's totals are summed from those, so a total never comes from a form.
//
//   const r = readLines([{ description: "Install", quantity: "1", unit: "450.00" }], "usd", rates);
//   if (!r.ok) show(r.errors);   // { "lines.0.unit": "Enter a price like 12.50." }
import type { Query } from "../data/db";
import { decimals, toMinor } from "../payments/money";
import type { TaxRate } from "../payments/tax";

export type Errors = Record<string, string>;
export type Saved<T = null> = { ok: true; value: T } | { ok: false; errors: Errors };

export type LineInput = { description?: unknown; quantity?: unknown; unit?: unknown; tax_rate_id?: unknown };
export type Line = { description: string; quantity: string; unit_cents: number; tax_rate_id: string | null };
export type SavedLine = Line & { id: string; position: number; amount_cents: string; tax_cents: string };

export const MAX_LINES = 100;

/**
 * Read lines as typed: blank rows are dropped, each row needs a description
 * and a price, a quantity defaults to 1. Errors are keyed `lines.<i>.<field>`
 * by the row's index in the input. A tax rate must be one of `rates` and
 * active.
 */
export function readLines(input: unknown, currency: string, rates: TaxRate[]): Saved<Line[]> {
  const rows = Array.isArray(input) ? (input as LineInput[]) : [];
  const errors: Errors = {};
  const out: Line[] = [];
  rows.forEach((row, i) => {
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
    const description = text(row?.description);
    const quantity = text(row?.quantity);
    const unit = text(row?.unit).replace(/^\p{Sc}\s*/u, "");
    const rate = text(row?.tax_rate_id);
    if (!description && !unit && (!quantity || quantity === "1") && !rate) return;
    const at = `lines.${i}`;
    if (!description || description.length > 500) errors[`${at}.description`] = "Describe the line in up to 500 characters.";
    const qty = quantity || "1";
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(qty) || Number(qty) <= 0) errors[`${at}.quantity`] = "Enter a quantity like 1 or 2.5.";
    const cents = toMinor(unit, currency);
    if (cents === null) errors[`${at}.unit`] = decimals(currency) ? "Enter a price like 12.50." : "Enter a whole price like 1200.";
    if (rate && !rates.some((r) => r.id === rate && r.active)) errors[`${at}.tax_rate_id`] = "Choose a tax rate from the list.";
    out.push({ description, quantity: qty, unit_cents: cents ?? 0, tax_rate_id: rate || null });
  });
  if (out.length > MAX_LINES) errors.lines = `Up to ${MAX_LINES} lines.`;
  if (!out.length && !Object.keys(errors).length) errors.lines = "Add at least one line.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
}

// A document's lines and totals. The tables are chosen from this fixed map,
// never from input. Lines change only while the document is editable: a
// draft quote, or a draft invoice not yet sent to Stripe.
export type DocKind = "quote" | "invoice";
const DOC = {
  // A draft quote with a Pay button out (an invoice made from it) no longer changes: the customer would pay the old lines.
  quote: { table: "quotes", lines: "quote_lines", key: "quote_id",
    editable: "quotes.status = 'draft' and not exists (select 1 from invoices i where i.quote_id = quotes.id and i.status <> 'void')" },
  invoice: { table: "invoices", lines: "invoice_lines", key: "invoice_id", editable: "invoices.status = 'draft' and invoices.stripe_invoice_id is null" },
} as const;

/** The document's id: the given one, or (null) the one just inserted in this transaction. */
const docId = (kind: DocKind, id: string | null, n: number) =>
  id === null ? `currval(pg_get_serial_sequence('${DOC[kind].table}', 'id'))` : `$${n}::bigint`;
const idValue = (id: string | null) => (id === null ? [] : [id]);

/** Insert lines, each with its amount (quantity x price, rounded) and its tax, while the document is editable. */
export function insertLines(kind: DocKind, id: string | null, lines: Line[]): Query {
  const d = DOC[kind], doc = docId(kind, id, 6);
  return {
    text: `insert into ${d.lines} (${d.key}, position, description, quantity, unit_cents, tax_rate_id, amount_cents, tax_cents)
      select ${doc}, u.position, u.description, u.quantity, u.unit_cents, u.tax_rate_id,
        round(u.quantity * u.unit_cents)::bigint,
        coalesce(case when t.inclusive
          then round(u.quantity * u.unit_cents) - round(round(u.quantity * u.unit_cents) * 10000.0 / (10000 + t.percent_bp))
          else round(round(u.quantity * u.unit_cents) * t.percent_bp / 10000.0) end, 0)::bigint
      from unnest($1::int[], $2::text[], $3::numeric[], $4::bigint[], $5::bigint[])
        as u(position, description, quantity, unit_cents, tax_rate_id)
      left join tax_rates t on t.id = u.tax_rate_id
      where exists (select 1 from ${d.table} where ${d.table}.id = ${doc} and ${d.editable})`,
    values: [lines.map((_, i) => i + 1), lines.map((l) => l.description), lines.map((l) => l.quantity),
      lines.map((l) => String(l.unit_cents)), lines.map((l) => l.tax_rate_id), ...idValue(id)],
  };
}

/** Remove an editable document's lines, before inserting its new ones. */
export function clearLines(kind: DocKind, id: string): Query {
  const d = DOC[kind];
  return {
    text: `delete from ${d.lines} where ${d.key} = $1::bigint and exists (select 1 from ${d.table} where ${d.table}.id = $1::bigint and ${d.editable})`,
    values: [id],
  };
}

/**
 * Sum an editable document's totals from its lines, as Stripe does: the
 * subtotal is the lines' amounts (inclusive tax already inside them), the
 * total adds the exclusive tax.
 */
export function sumLines(kind: DocKind, id: string | null): Query {
  const d = DOC[kind], doc = docId(kind, id, 1);
  return {
    text: `update ${d.table} set subtotal_cents = s.subtotal, tax_cents = s.tax, total_cents = s.subtotal + s.exclusive, updated_at = now()
      from (select coalesce(sum(l.amount_cents), 0) as subtotal, coalesce(sum(l.tax_cents), 0) as tax,
                   coalesce(sum(l.tax_cents) filter (where not coalesce(t.inclusive, false)), 0) as exclusive
            from ${d.lines} l left join tax_rates t on t.id = l.tax_rate_id where l.${d.key} = ${doc}) s
      where ${d.table}.id = ${doc} and ${d.editable}`,
    values: idValue(id),
  };
}

/** Minor units as a typed amount for an input: 45000 usd is "450.00", 1200 jpy is "1200". */
export function amountInput(cents: number | string, currency: string): string {
  const d = decimals(currency);
  const n = BigInt(cents);
  if (!d) return n.toString();
  const neg = n < 0n, abs = neg ? -n : n, unit = 10n ** BigInt(d);
  return `${neg ? "-" : ""}${abs / unit}.${(abs % unit).toString().padStart(d, "0")}`;
}

export const toLine = (r: Record<string, any>): SavedLine => ({
  id: String(r.id),
  position: Number(r.position),
  description: r.description,
  quantity: String(Number(r.quantity)),
  unit_cents: Number(r.unit_cents),
  tax_rate_id: r.tax_rate_id == null ? null : String(r.tax_rate_id),
  amount_cents: String(r.amount_cents),
  tax_cents: String(r.tax_cents),
});

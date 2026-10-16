// The parts of a document's form that every one shares: who it is for and
// its line items, with one tax for the whole document. Quotes, invoices and
// recurring invoices use them (admin.tsx, recurring-admin.tsx).
import { Section } from "../admin/detail";
import { str } from "../admin/query";
import { controlClass, FieldError, fieldClass, Select } from "../admin/status";
import { percentText, type TaxRate } from "../payments/tax";
import { amountInput, type Errors, type SavedLine } from "./lines";

export type FormLine = { description: string; quantity: string; unit: string; tax_rate_id: string };

const BLANK_ROWS = 3;

const errText = (errors: Errors, k: string) => (errors[k] ? <span class="text-ink" id={`err-${k.replace(/\./g, "-")}`}>{errors[k]}</span> : null);

/**
 * The form's repeated line fields as rows, by index. Tax is one choice for
 * the whole document (`tax`, as Jobber's): it goes on every line that has
 * something on it. "mixed" keeps each line's own (one the AI made per line).
 */
export function formLines(body: Record<string, unknown>): { description: string; quantity: string; unit: string; tax_rate_id: string }[] {
  const all = (k: string) => {
    const v = body[k];
    return Array.isArray(v) ? v.map(str) : v === undefined ? [] : [str(v)];
  };
  const d = all("description"), q = all("quantity"), u = all("unit"), t = all("tax_rate_id");
  const tax = str(body.tax);
  return Array.from({ length: Math.min(Math.max(d.length, q.length, u.length), 200) }, (_, i) => ({
    description: d[i] ?? "", quantity: q[i] ?? "", unit: u[i] ?? "",
    tax_rate_id: tax === "mixed" ? (t[i] ?? "") : (d[i] ?? "").trim() || (u[i] ?? "").trim() ? tax : "",
  }));
}

/** The one tax a document's lines share: "" for none, a rate's id, or "mixed" when the lines differ. */
export function docTax(lines: { tax_rate_id: string }[]): string {
  const ids = new Set(lines.map((l) => l.tax_rate_id));
  return ids.size > 1 ? "mixed" : ([...ids][0] ?? "");
}

/** A document's lines as the form shows them. */
export const linesOf = (d: { currency: string; lines: SavedLine[] }) =>
  d.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: amountInput(l.unit_cents, d.currency), tax_rate_id: l.tax_rate_id ?? "" }));

export function CustomerFields({ v, errors }: { v: { email: string; name: string; phone: string; address: string }; errors: Errors }) {
  const err = (k: string) => errText(errors, k);
  return (
    <Section title="Customer">
      <div class="grid gap-3 sm:grid-cols-2">
        <label class={fieldClass}>Email<input name="email" type="email" required value={v.email} maxlength={254} class={controlClass} />{err("email")}</label>
        <label class={fieldClass}>Name<input name="name" value={v.name} maxlength={200} class={controlClass} />{err("name")}</label>
        <label class={fieldClass}>Phone<input name="phone" type="tel" value={v.phone} maxlength={50} class={controlClass} />{err("phone")}</label>
        <label class={fieldClass}>Address<input name="address" value={v.address} maxlength={500} autocomplete="off" class={controlClass} />{err("address")}</label>
      </div>
    </Section>
  );
}

export function LineItems({ lines, errors, rates, taxPage }: { lines: FormLine[]; errors: Errors; rates: TaxRate[]; taxPage: string }) {
  const err = (k: string) => errText(errors, k);
  const offered = rates.filter((r) => r.active || lines.some((l) => l.tax_rate_id === r.id));
  const rows = [...lines, ...Array.from({ length: Math.max(BLANK_ROWS, 5 - lines.length) }, () => ({ description: "", quantity: "", unit: "", tax_rate_id: "" }))];
  const tax = docTax(lines.filter((l) => l.description || l.unit));
  const mixed = tax === "mixed";
  const taxError = Object.entries(errors).find(([k]) => k.endsWith(".tax_rate_id"))?.[1];
  return (
    <Section title="Line items">
      <p class="mb-3 text-label text-ink-3">Blank rows are left out. Save to get more rows.</p>
      {err("lines")}
      <div class="flex flex-col gap-3">
        {rows.map((l, i) => {
          // The column names show once, over the first row; each row's own are for a phone and a screen reader.
          const name = (text: string) => <span class={i ? "sm:sr-only" : ""}>{text}</span>;
          return (
          <fieldset class={"grid gap-2 sm:grid-cols-12 " + (i ? "border-t border-line pt-3 sm:border-0 sm:pt-0" : "")}>
            <legend class="sr-only">Line {i + 1}</legend>
            <label class={fieldClass + " sm:col-span-8"}>{name("Description")}<input name="description" value={l.description} maxlength={500} class={controlClass} />{err(`lines.${i}.description`)}</label>
            <label class={fieldClass + " sm:col-span-2"}>{name("Qty")}<input name="quantity" value={l.quantity} placeholder="1" inputmode="decimal" class={controlClass} />{err(`lines.${i}.quantity`)}</label>
            <label class={fieldClass + " sm:col-span-2"}>{name("Price")}<input name="unit" value={l.unit} inputmode="decimal" class={controlClass} />{err(`lines.${i}.unit`)}</label>
            {mixed ? <input type="hidden" name="tax_rate_id" value={l.tax_rate_id} /> : null}
          </fieldset>
          );
        })}
      </div>
      {/* One tax for the whole document, none unless chosen; rates are kept on their own page. */}
      <div class="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
        <label class={fieldClass}>Tax
          <Select name="tax" aria-describedby={taxError ? "tax-error" : undefined}>
            <option value="">No tax</option>
            {offered.map((r) => <option value={r.id} selected={r.id === tax}>{r.name} ({percentText(r.percent_bp)})</option>)}
            {mixed ? <option value="mixed" selected>Different on each line</option> : null}
          </Select>
        </label>
        <a href={taxPage} class="pb-2 text-label text-ink-2">Manage tax rates</a>
        <FieldError id="tax-error" text={taxError} />
      </div>
    </Section>
  );
}

// The parts of a document's form that every one shares: who it is for and
// its line items, with one tax for the whole document. Quotes, invoices and
// recurring invoices use them (admin.tsx, recurring-admin.tsx).
import { raw } from "hono/html";
import { Section } from "../admin/detail";
import type { Db } from "../data/db";
import { str } from "../admin/query";
import { buttonClass, controlClass, FieldError, fieldClass, Select } from "../admin/status";
import { percentText, type TaxRate } from "../payments/tax";
import { amountInput, type Errors, type SavedLine } from "./lines";

export type FormLine = { description: string; quantity: string; unit: string; tax_rate_id: string };

export type Person = { name: string; email: string; phone: string | null; address: string | null };

/** Who a document can be for, to pick instead of typing; an app without the customers skill has nobody here. */
export const peopleOf = (db: Db) =>
  db.sql<Person>`select name, email::text as email, phone, address from customers where email is not null and archived_at is null and merged_into is null order by updated_at desc limit 500`.catch(() => [] as Person[]);

/** Picking an email fills in what is blank. */
const FILL_PERSON = `(function(){var s=document.currentScript,g=s.closest('[data-people]');var all=JSON.parse(g.dataset.people);var e=g.querySelector('[name=email]');e.addEventListener('input',function(){var p=all.find(function(x){return x.email.toLowerCase()===e.value.trim().toLowerCase()});if(!p)return;['name','phone','address'].forEach(function(k){var i=g.querySelector('[name='+k+']');if(i&&!i.value&&p[k])i.value=p[k]})})})()`;

/** A row more without saving, and the running total, as Stripe's invoice editor has them. Without JavaScript a save brings blank rows. */
const LINE_EDITING = `(function(){var g=document.currentScript.closest('[data-lines]');var box=g.querySelector('[data-rows]');var out=g.querySelector('[data-total]');var fmt=new Intl.NumberFormat(undefined,{style:'currency',currency:g.dataset.currency});function num(v){var n=parseFloat(String(v).replace(/[^0-9.]/g,''));return isNaN(n)?0:n}function total(){var t=0;box.querySelectorAll('fieldset').forEach(function(f){var u=f.querySelector('[name=unit]').value;if(!u)return;var q=f.querySelector('[name=quantity]').value;t+=num(u)*(q===''?1:num(q))});out.textContent=fmt.format(t)}box.addEventListener('input',total);total();g.querySelector('[data-add]').hidden=false;g.querySelector('[data-add]').addEventListener('click',function(){var rows=box.querySelectorAll('fieldset');var n=rows[rows.length-1].cloneNode(true);n.querySelectorAll('input').forEach(function(i){if(i.type!=='hidden')i.value=''});n.querySelectorAll('[id^=err-]').forEach(function(x){x.remove()});n.querySelectorAll('label > span:first-child').forEach(function(x){x.className='sm:sr-only'});n.classList.add('border-t','border-line','pt-3','sm:border-0','sm:pt-0');box.appendChild(n);n.querySelector('[name=description]').focus()})})()`;
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

export function CustomerFields({ v, errors, people = [] }: { v: { email: string; name: string; phone: string; address: string }; errors: Errors; people?: Person[] }) {
  const err = (k: string) => errText(errors, k);
  return (
    <Section title="Customer">
      <div class="grid gap-3 sm:grid-cols-2" data-people={people.length ? JSON.stringify(people) : undefined}>
        {people.length ? <datalist id="doc-people">{people.map((p) => <option value={p.email} label={p.name} />)}</datalist> : null}
        <label class={fieldClass}>Email<input name="email" type="email" required value={v.email} maxlength={254} list={people.length ? "doc-people" : undefined} autocomplete="off" class={controlClass} />{err("email")}</label>
        <label class={fieldClass}>Name<input name="name" value={v.name} maxlength={200} class={controlClass} />{err("name")}</label>
        <label class={fieldClass}>Phone<input name="phone" type="tel" value={v.phone} maxlength={50} class={controlClass} />{err("phone")}</label>
        <label class={fieldClass}>Address<input name="address" value={v.address} maxlength={500} autocomplete="off" class={controlClass} />{err("address")}</label>
        {people.length ? <script>{raw(FILL_PERSON)}</script> : null}
      </div>
    </Section>
  );
}

export function LineItems({ lines, errors, rates, taxPage, currency }: { lines: FormLine[]; errors: Errors; rates: TaxRate[]; taxPage: string; currency: string }) {
  const err = (k: string) => errText(errors, k);
  const offered = rates.filter((r) => r.active || lines.some((l) => l.tax_rate_id === r.id));
  const rows = [...lines, ...Array.from({ length: 1 }, () => ({ description: "", quantity: "", unit: "", tax_rate_id: "" }))];
  const tax = docTax(lines.filter((l) => l.description || l.unit));
  const mixed = tax === "mixed";
  const taxError = Object.entries(errors).find(([k]) => k.endsWith(".tax_rate_id"))?.[1];
  return (
    <Section title="Line items">
      <div data-lines data-currency={currency.toUpperCase() || "USD"}>
      <noscript><p class="mb-3 text-label text-ink-3">Blank rows are left out. Save to get more rows.</p></noscript>
      {err("lines")}
      <div class="flex flex-col gap-3" data-rows>
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
      <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
        <button type="button" data-add hidden class={buttonClass}>Add a line</button>
        <p class="ml-auto font-semibold">Subtotal <output data-total></output></p>
      </div>
      <script>{raw(LINE_EDITING)}</script>
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
      </div>
    </Section>
  );
}

/**
 * New invoice's first choice, as QuickBooks' and Stripe's editors ask it: one
 * invoice, or one that repeats (a recurring invoice). Who it is for and the
 * quote it goes on (the query) carry over.
 */
export function OneOrRepeats({ base, repeats, query }: { base: string; repeats: boolean; query: string }) {
  const tab = (href: string, label: string, on: boolean) => (
    <a href={href} aria-current={on ? "page" : undefined}
      class={"rounded-control px-3 py-1.5 no-underline " + (on ? "bg-surface font-medium text-ink shadow-card" : "text-ink-2 hover:text-ink")}>{label}</a>
  );
  return (
    <nav aria-label="One invoice or repeating" class="mb-4 inline-flex gap-1 rounded-control bg-panel p-1">
      {tab(`${base}/new${query}`, "One invoice", !repeats)}
      {tab(`${base}/recurring/new${query}`, "Repeats", repeats)}
    </nav>
  );
}

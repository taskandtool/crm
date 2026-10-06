// Quotes and invoices where the team already looks: a customer's page (what
// was quoted, what is owed now, what was paid), a job's page (its quote and
// invoice), and the top of the invoices list (what was paid, by month).
import { Section } from "../admin/detail";
import { StatusBadge } from "../admin/status";
import { listUrl } from "../admin/query";
import type { Customer } from "../crm/customers";
import { INVOICE_OPTIONS, QUOTE_OPTIONS, todayIn } from "../invoices/admin";
import { dayText } from "../invoices/document";
import type { Invoice } from "../invoices/invoices";
import { shownStatus, type Quote } from "../invoices/quotes";
import { formatMoney } from "../payments/money";
import { timeZone } from "./ui";

export type Owed = { currency: string; cents: string; count: number };

function Docs({ quotes, invoices }: { quotes: Quote[]; invoices: Invoice[] }) {
  const today = todayIn(timeZone);
  if (!quotes.length && !invoices.length) return <p class="text-ink-3">No quotes or invoices yet.</p>;
  return (
    <ul class="flex flex-col gap-2">
      {quotes.map((q) => (
        <li class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <a href={`/invoices/quotes/${q.id}`}>Quote {q.number}</a>
          <StatusBadge value={shownStatus(q, today)} options={QUOTE_OPTIONS} />
          <span class="whitespace-nowrap">{formatMoney(q.total_cents, q.currency)}</span>
        </li>
      ))}
      {invoices.map((i) => (
        <li class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <a href={`/invoices/${i.id}`}>{i.number ? `Invoice ${i.number}` : "Draft invoice"}</a>
          <StatusBadge value={i.status} options={INVOICE_OPTIONS} />
          <span class="whitespace-nowrap">{formatMoney(i.total_cents, i.currency)}</span>
          {i.status === "open" && i.due_date ? <span class="text-label text-ink-3">due {dayText(i.due_date)}</span> : null}
          {i.livemode === false ? <span class="text-label text-ink-3">test mode</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** A customer's quotes and invoices, and what they owe now (open, live money, one figure per currency). */
export function CustomerMoney({ c, quotes, invoices, owed }: { c: Customer; quotes: Quote[]; invoices: Invoice[]; owed: Owed[] }) {
  const who = { email: c.email, name: c.name, phone: c.phone, address: c.address };
  return (
    <Section title="Quotes and invoices">
      {owed.length ? (
        <p class="mb-3 font-semibold">
          Owes {owed.map((o) => formatMoney(o.cents, o.currency)).join(" and ")} on {owed.reduce((n, o) => n + o.count, 0) === 1 ? "an open invoice" : `${owed.reduce((n, o) => n + o.count, 0)} open invoices`}.
        </p>
      ) : null}
      <Docs quotes={quotes} invoices={invoices} />
      <p class="mt-3 flex flex-wrap gap-x-4 text-label">
        <a href={listUrl("/invoices/quotes/new", who)}>New quote</a>
        <a href={listUrl("/invoices/new", who)}>New invoice</a>
      </p>
    </Section>
  );
}

/** A job's quote and invoice. */
export function VisitMoney({ quotes, invoices }: { quotes: Quote[]; invoices: Invoice[] }) {
  return (
    <Section title="Quote and invoice">
      <Docs quotes={quotes} invoices={invoices} />
    </Section>
  );
}

export type PaidMonth = { currency: string; months: { bucket: string; value: number }[] };

/** Paid invoices by month, live money, one row of months per currency. */
export function PaidByMonth({ rows }: { rows: PaidMonth[] }) {
  if (!rows.length) return null;
  const month = (b: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", year: "2-digit" }).format(new Date(b + "T00:00:00Z"));
  return (
    <details class="mb-4 rounded-card border border-line bg-surface p-4">
      <summary class="cursor-pointer text-label font-semibold text-ink-2">Paid by month</summary>
      {rows.map((r) => (
        <div class="mt-3 overflow-x-auto">
          <table class="w-full border-collapse text-label">
            <caption class="sr-only">Invoices paid by month, {r.currency.toUpperCase()}</caption>
            <thead>
              <tr class="border-b border-line-strong text-left text-ink-3">
                {r.months.map((m) => <th scope="col" class="whitespace-nowrap px-2 py-1 text-right font-semibold">{month(m.bucket)}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr>
                {r.months.map((m) => <td class="whitespace-nowrap px-2 py-1 text-right">{m.value ? formatMoney(m.value, r.currency) : <span class="text-ink-3">0</span>}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      ))}
      <p class="mt-2 text-label text-ink-3">Invoices marked paid, by the month they were paid, the current month so far. Stripe test mode is left out.</p>
    </details>
  );
}

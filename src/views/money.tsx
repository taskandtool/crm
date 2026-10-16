// Quotes and invoices where the team already looks: a customer's page (what
// was quoted, what is owed now, what was paid) and an event's page (its quote and
// invoice). An overdue one says Past due, as on the invoices page.
import { Section } from "../admin/detail";
import { AddLink } from "./ui";
import { StatusBadge } from "../admin/status";
import { listUrl } from "../admin/query";
import type { Customer } from "../crm/customers";
import { QUOTE_OPTIONS, SHOWN_INVOICE } from "../invoices/admin";
import { todayIn } from "../reports/sql";
import { When } from "../admin/list";
import { pastDue, type Invoice } from "../invoices/invoices";
import { shownStatus, type Quote } from "../invoices/quotes";
import { formatMoney } from "../payments/money";
import { cardName, type Card } from "../invoices/cards";
import type { Recurring } from "../invoices/recurring";
import { CardsOnFile, RecurringLines } from "../invoices/recurring-admin";
import { timeZone } from "./ui";

export type Owed = { currency: string; cents: string; count: number };

export function Docs({ quotes, invoices }: { quotes: Quote[]; invoices: Invoice[] }) {
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
          <StatusBadge value={pastDue(i, today, quotes.find((q) => q.id === i.quote_id) ?? null) ? "due" : i.status} options={SHOWN_INVOICE} />
          <span class="whitespace-nowrap">{formatMoney(i.total_cents, i.currency)}</span>
          {i.status === "open" && i.due_date ? <span class="text-label text-ink-3">due <When at={`${i.due_date}T00:00:00Z`} timeZone="UTC" day /></span> : null}
          {i.livemode === false ? <span class="text-label text-ink-3">test mode</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * A customer's quotes and invoices, what they owe now (open, live money, one
 * figure per currency), their recurring invoices and the cards they saved.
 */
export function CustomerMoney({ c, quotes, invoices, owed, recurring, cards }: { c: Customer; quotes: Quote[]; invoices: Invoice[]; owed: Owed[]; recurring: Recurring[]; cards: Card[] }) {
  const who = { email: c.email, name: c.name, phone: c.phone, address: c.address };
  const charged = cards.find((x) => x.isDefault && x.livemode) ?? cards.find((x) => x.isDefault) ?? null;
  return (
    <Section title="Quotes and invoices">
      {owed.length ? (
        <p class="mb-3 font-semibold">
          Owes {owed.map((o) => formatMoney(o.cents, o.currency)).join(" and ")} on {owed.reduce((n, o) => n + o.count, 0) === 1 ? "an open invoice" : `${owed.reduce((n, o) => n + o.count, 0)} open invoices`}.
        </p>
      ) : null}
      <Docs quotes={quotes} invoices={invoices} />
      {recurring.length ? (
        <div class="mt-4 border-t border-line pt-3">
          <h3 class="mb-1 font-semibold">Recurring</h3>
          <RecurringLines list={recurring} base="/invoices" card={charged ? cardName(charged) : null} />
        </div>
      ) : null}
      {cards.length || recurring.some((r) => r.mode === "charge" && r.status !== "ended") ? (
        <div class="mt-4 border-t border-line pt-3">
          <h3 class="mb-1 font-semibold">Card on file</h3>
          {c.email ? <CardsOnFile cards={cards} base="/invoices" back={`/customers/${c.id}`} email={c.email} /> : null}
        </div>
      ) : null}
      <p class="mt-3 flex flex-wrap gap-x-4">
        <AddLink href={listUrl("/invoices/quotes/new", who)}>New quote</AddLink>
        <AddLink href={listUrl("/invoices/new", who)}>New invoice</AddLink>
        <AddLink href={listUrl("/invoices/recurring/new", who)}>New recurring invoice</AddLink>
      </p>
    </Section>
  );
}

/** An event's quote and invoice. */
export function EventMoney({ quotes, invoices }: { quotes: Quote[]; invoices: Invoice[] }) {
  return (
    <Section title="Quote and invoice">
      <Docs quotes={quotes} invoices={invoices} />
    </Section>
  );
}

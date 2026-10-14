// The schedule's events (crm.config.json's `events` names them): the section
// on a customer's page with its add form, the list, and one event's own page.
// Plain forms throughout, answered with a 303. A status change posts to the
// booking pages' own route (/schedule/:id/status), which tells an online
// booker of a cancel and comes back here.
import { JsonData, Section } from "../admin/detail";
import { Flash } from "../admin/flash";
import { DataTable, EmptyState, NoMatches, SearchBar, When, type TableSpec } from "../admin/list";
import { listUrl } from "../admin/query";
import { StatusBadge } from "../admin/status";
import { BOOKING_STATUSES } from "../booking/admin";
import { whereText, type BookingType, type Resource } from "../booking/book";
import { durationText } from "../booking/slots";
import { dealsCfg, eventsCfg, invoicesCfg, ownerLabel, vocab } from "../config";
import type { CustomField } from "../config-schema";
import type { Customer } from "../crm/customers";
import { LENGTHS, minutesOf, type Event, type EventFilter } from "../crm/events";
import { amountText, nowIn } from "../crm/text";
import type { Invoice } from "../invoices/invoices";
import type { Quote } from "../invoices/quotes";
import { formatMoney } from "../payments/money";
import { Layout, ScheduleTabs } from "./layout";
import { EventMoney } from "./money";
import { AddToggle, buttonClass, controlClass, CustomInput, CustomerPicker, Field, MESSAGES, primaryClass, ReadThenEdit, RecordLine, shownField, telHref, timeZone, ViewLink, viewsClass } from "./ui";

/** How many a customer's page shows. */
export const CUSTOMER_EVENTS = 100;

const ev = eventsCfg ?? { one: "Event", many: "Events", fields: [] as CustomField[], currency: "USD" };
const one = ev.one.toLowerCase();
const many = ev.many.toLowerCase();

/** What the forms choose from: the Team, and the Services when there are any. */
export type Choices = { team: Resource[]; services: BookingType[] };

/** A scheduled one whose time is over: still says Scheduled, and says it is overdue (not marked), as a task past its day is. */
const overdue = (r: Event, now = Date.now()) => r.status === "confirmed" && new Date(r.ends_at).getTime() < now;

const Overdue = ({ r }: { r: Event }) => (overdue(r) ? <span class="block text-label font-semibold text-late">Overdue</span> : null);

/** A status as the team reads it: "Scheduled", "No-show". */
export const statusLabel = (s: string) => BOOKING_STATUSES.find((o) => o.value === s)?.label ?? s;

function WhenOf({ r }: { r: Event }) {
  return (
    <>
      <When at={r.starts_at} timeZone={timeZone} />
      <Overdue r={r} />
    </>
  );
}

const amountOf = (r: Event) => (r.amount_cents === null ? "" : formatMoney(r.amount_cents, r.currency ?? ev.currency));

/** The custom fields that have a value, as "Truck 2 · North". */
const fieldsLine = (r: Event) =>
  ev.fields
    .map((f) => shownField(f, r.fields?.[f.key]))
    .filter(Boolean)
    .join(" · ");


/** Who it is for: their record when they are a customer, else the name the booking holds. */
function Who({ r }: { r: Event }) {
  return r.customer_id ? <a href={`/customers/${r.customer_id}`} class="break-words">{r.customer_name}</a> : <span class="break-words">{r.name}</span>;
}

type DealChoice = { id: string; title: string };

/**
 * The form's own fields, for adding one and for its page. `where` fills a new
 * one's place (the customer's address); `deals` are the customer's to choose
 * from, as a task's are, with `dealId` chosen.
 */
function EventFields({ r, choices, where, deals = [], dealId = null }: { r?: Event; choices: Choices; where?: string | null; deals?: DealChoice[]; dealId?: string | null }) {
  const length = r ? minutesOf(r) : 60;
  const lengths = LENGTHS.includes(length) ? LENGTHS : [...LENGTHS, length].sort((a, b) => a - b);
  return (
    <>
      <Field label="Title" class="sm:col-span-2" hint={choices.services.length ? "Blank uses the service's name." : undefined}>
        <input name="title" value={r?.title ?? ""} maxlength={200} required={!choices.services.length} placeholder={`What the ${one} is for`} class={controlClass} />
      </Field>
      {choices.services.length ? (
        <Field label="Service">
          <select name="type" class={controlClass}>
            <option value="">None</option>
            {choices.services.map((t) => <option value={t.id} selected={t.id === r?.type_id}>{t.name}</option>)}
          </select>
        </Field>
      ) : null}
      <Field label={ownerLabel}>
        <select name="host" class={controlClass}>
          <option value="">Nobody yet</option>
          {choices.team.map((p) => <option value={p.id} selected={p.id === r?.resource_id}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="When">
        <input name="at" type="datetime-local" required value={r ? nowIn(timeZone, new Date(r.starts_at)) : ""} class={controlClass} />
      </Field>
      <Field label="Length">
        <select name="minutes" class={controlClass}>
          {lengths.map((m) => <option value={String(m)} selected={m === length}>{durationText(m)}</option>)}
        </select>
      </Field>
      <Field label="Where" class="sm:col-span-2">
        <input name="location" value={r ? (r.location ?? "") : (where ?? "")} maxlength={500} class={controlClass} />
      </Field>
      {deals.length ? (
        <Field label={dealsCfg.one}>
          <select name="deal" class={controlClass}>
            <option value="">None</option>
            {deals.map((d) => <option value={d.id} selected={d.id === dealId}>{d.title}</option>)}
          </select>
        </Field>
      ) : null}
      <Field label={`Amount (${ev.currency})`}>
        <input name="amount" inputmode="decimal" value={r ? amountText(r.amount_cents, r.currency ?? ev.currency) : ""} maxlength={20} class={controlClass} />
      </Field>
      {ev.fields.map((f) => (
        <CustomInput f={f} value={r?.fields?.[f.key]} />
      ))}
      <Field label="Notes" class="sm:col-span-2">
        <textarea name="notes" rows={3} maxlength={10000} class={controlClass}>
          {r?.notes ?? ""}
        </textarea>
      </Field>
    </>
  );
}

/** The section on a customer's page (theirs) or a deal's (its own, `dealId`), and a form to add one. */
export function CustomerEvents({ c, events, choices, deals, dealId = null }: { c: Customer; events: Event[]; choices: Choices; deals: DealChoice[]; dealId?: string | null }) {
  return (
    <div class="flex flex-col gap-4">
      {events.length ? (
        <ol class="flex flex-col gap-3">
          {events.map((r) => (
            <li class="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-l-2 border-line pl-3">
              <div class="min-w-0">
                <a href={`/events/${r.id}`} class="font-semibold no-underline underline-offset-2 hover:underline">
                  {r.what}
                </a>
                {/* One line under its name, as Home's Today: when (and Overdue), then its deal, who takes it, the amount. */}
                <p class="text-label text-ink-3">
                  <span class="text-ink-2"><When at={r.starts_at} timeZone={timeZone} /></span>
                  {overdue(r) ? <> · <span class="font-semibold text-late">Overdue</span></> : null}
                  {[dealId ? null : r.deal_title, r.host_name, amountOf(r), fieldsLine(r)].filter(Boolean).map((x) => ` · ${x}`).join("")}
                </p>
              </div>
              <StatusBadge value={r.status} options={BOOKING_STATUSES} />
            </li>
          ))}
        </ol>
      ) : (
        <p class="text-ink-3">No {many} yet.</p>
      )}
      {events.length >= CUSTOMER_EVENTS ? (
        <p class="text-label text-ink-3">
          The {CUSTOMER_EVENTS} most recent. The rest are in <a href={`/events?view=all&q=${encodeURIComponent(c.name)}`}>All {many}</a>.
        </p>
      ) : null}
      <AddToggle label={`Add ${one}`}>
        <form method="post" action={`/customers/${c.id}/events`} aria-label={`Add ${/^[aeiou]/i.test(one) ? "an" : "a"} ${one}`} class="grid gap-3 sm:grid-cols-2">
          <EventFields choices={choices} where={c.address} deals={deals} dealId={dealId} />
          <div class="sm:col-span-2">
            <button class={buttonClass}>Add {one}</button>
          </div>
        </form>
      </AddToggle>
    </div>
  );
}

const VIEWS: { value: EventFilter["view"]; label: string }[] = [
  { value: "upcoming", label: "Upcoming" },
  { value: "overdue", label: "Overdue" },
  { value: "past", label: "Past" },
  { value: "all", label: "All" },
];

export function eventSpec(): TableSpec<Event> {
  return {
    id: "events",
    href: (r) => `/events/${r.id}`,
    columns: [
      {
        label: "When",
        cell: (r) => (
          <span class="whitespace-nowrap">
            <WhenOf r={r} />
            {r.status !== "confirmed" ? <span class="block text-label font-normal text-ink-2 sm:hidden">{statusLabel(r.status)}</span> : null}
          </span>
        ),
      },
      {
        label: ev.one,
        cell: (r) => (
          <>
            {r.what}
            {r.deal_title || fieldsLine(r) ? <span class="block text-label text-ink-2">{[r.deal_title, fieldsLine(r)].filter(Boolean).join(" · ")}</span> : null}
          </>
        ),
      },
      { label: vocab.one, cell: (r) => <Who r={r} /> },
      { label: "Status", class: "hidden sm:table-cell", cell: (r) => <StatusBadge value={r.status} options={BOOKING_STATUSES} /> },
      { label: ownerLabel, class: "hidden md:table-cell", cell: (r) => r.host_name ?? "" },
      { label: "Amount", class: "hidden sm:table-cell text-right", cell: (r) => <span class="whitespace-nowrap">{amountOf(r)}</span> },
    ],
  };
}

export const eventParams = (f: EventFilter) => ({ q: f.q, view: f.view === "upcoming" ? null : f.view, host: f.host });

export function EventResults(p: { filter: EventFilter; rows: Event[]; next: string | null; paged: boolean }) {
  const params = eventParams(p.filter);
  return (
    <div id="results">
      {p.paged ? (
        <p class="mb-3 text-label">
          <a href={listUrl("/events", params)}>Back to the first page</a>
        </p>
      ) : null}
      <DataTable
        spec={eventSpec()}
        caption={p.filter.view === "upcoming" ? `Upcoming ${many}, soonest first` : p.filter.view === "overdue" ? `Overdue ${many}, oldest first` : `${ev.many}, newest first`}
        rows={p.rows}
        next={p.next}
        more={(cur) => listUrl("/events", { ...params, after: cur })}
        empty={
          p.filter.host || p.filter.q ? (
            <NoMatches clear={listUrl("/events", { view: params.view })} />
          ) : (
            <EmptyState title={p.filter.view === "upcoming" ? `Nothing scheduled.` : p.filter.view === "overdue" ? "Nothing overdue." : `No ${many} yet.`} action={<a href="/events/new" class={buttonClass}>New {one}</a>}>
              {p.filter.view === "upcoming" ? `Add one here or from a ${vocab.one.toLowerCase()}'s page. Online bookings show here too.` : null}
            </EmptyState>
          )
        }
      />
      <p class="mt-3 text-label">
        <a href={listUrl("/events/export.csv", params)}>Export CSV</a>
      </p>
    </div>
  );
}

export function EventsPage(p: {
  user: string;
  team: Resource[];
  filter: EventFilter;
  rows: Event[];
  next: string | null;
  paged: boolean;
  flash: { code?: string | null; n?: string | null };
}) {
  return (
    <Layout title={ev.many} user={p.user} section="schedule" actions={<a href="/events/new" class={primaryClass}>New {one}</a>}>
      <ScheduleTabs current="/events" />
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <nav aria-label="Which" class={"mb-4 " + viewsClass}>
        {VIEWS.map((v) => (
          <ViewLink href={listUrl("/events", { view: v.value === "upcoming" ? null : v.value, host: p.filter.host, q: p.filter.q })} on={p.filter.view === v.value}>
            {v.label}
          </ViewLink>
        ))}
      </nav>
      <SearchBar
        action="/events"
        target="#results"
        q={p.filter.q}
        placeholder={`Search ${many} or ${vocab.many.toLowerCase()}`}
        keep={{ view: p.filter.view === "upcoming" ? null : p.filter.view }}
        filters={[{ name: "host", label: ownerLabel, options: p.team.map((t) => ({ value: t.id, label: t.name })), value: p.filter.host, any: "Anyone" }]}
      />
      <EventResults filter={p.filter} rows={p.rows} next={p.next} paged={p.paged} />
    </Layout>
  );
}

/** A new one from the list: the customer picked, or someone new, and the event. */
export function NewEventPage(p: { user: string; choices: Choices; customers: { id: string; name: string; email: string | null }[]; flash: { code?: string | null; n?: string | null } }) {
  return (
    <Layout title={`New ${one}`} user={p.user} section="schedule" back={{ href: "/events", label: ev.many }}>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <form method="post" action="/events" class="grid max-w-3xl gap-3 rounded-card border border-line bg-surface shadow-card p-4 sm:grid-cols-2">
        <CustomerPicker customers={p.customers} />
        <EventFields choices={p.choices} />
        <div class="sm:col-span-2">
          <button class={primaryClass}>Create {one}</button>
        </div>
      </form>
    </Layout>
  );
}

/** A status button: it posts to the booking pages' route, which comes back here. */
function StatusButton({ id, status, label, primary, ask }: { id: string; status: string; label: string; primary?: boolean; ask?: string }) {
  return (
    <form method="post" action={`/schedule/${id}/status`} onsubmit={ask ? `return confirm(${JSON.stringify(ask)})` : undefined}>
      <input type="hidden" name="status" value={status} />
      <button class={primary ? primaryClass : buttonClass}>{label}</button>
    </form>
  );
}

/** One event: what, when and for whom at the top, its details with Edit, its quote and invoice. */
export function EventPage(p: {
  user: string; event: Event; choices: Choices; money: { quotes: Quote[]; invoices: Invoice[] } | null;
  /** Its customer's deals to choose from. */ deals: DealChoice[]; flash: { code?: string | null; n?: string | null };
}) {
  const r = p.event;
  const self = `/events/${r.id}`;
  const started = new Date(r.starts_at).getTime() <= Date.now();
  const doc = {
    email: r.email, name: r.customer_name ?? r.name, phone: r.phone, event: r.id, deal: r.deal_id, line: r.what,
    unit: r.amount_cents === null ? null : amountText(r.amount_cents, r.currency ?? ev.currency),
    currency: r.amount_cents === null ? null : r.currency,
  };
  const custom = ev.fields.map((f) => ({ label: f.label, value: shownField(f, r.fields?.[f.key]) || null }));
  const { notes: theirNote, ...answers } = r.answers as Record<string, unknown>;
  // Invoiced already (a void one does not count): no second Invoice.
  const billed = !!p.money?.invoices.some((i) => i.status !== "void");
  return (
    <Layout
      title={r.what}
      user={p.user}
      section="schedule"
      back={{ href: "/events", label: ev.many }}
      sub={
        <p class="flex flex-wrap items-center gap-x-2">
          <StatusBadge value={r.status} options={BOOKING_STATUSES} />
          <Who r={r} />
          {r.phone ? <><span aria-hidden="true">·</span><a href={telHref(r.phone)} class="whitespace-nowrap text-ink-2">{r.phone}</a></> : null}
        </p>
      }
      // Only the changes that can happen: completed and no-show once it has started; a cancelled one stays cancelled.
      actions={
        <>
          {invoicesCfg && r.email && r.status === "confirmed" ? <a href={listUrl("/invoices/quotes/new", doc)} class={buttonClass}>New quote</a> : null}
          {invoicesCfg && r.email && r.status === "completed" && !billed ? <a href={listUrl("/invoices/new", doc)} class={primaryClass}>New invoice</a> : null}
          {r.status === "confirmed" && started ? <StatusButton id={r.id} status="completed" label="Mark completed" primary /> : null}
          {started && r.status === "confirmed" ? <StatusButton id={r.id} status="no_show" label="No-show" /> : null}
          {/* One of a service, with someone taking it: another of their open times, the booker told. */}
          {r.status === "confirmed" && !started && r.type_id && r.resource_id ? <a href={`/schedule/${r.id}/reschedule`} class={buttonClass}>Reschedule</a> : null}
          {r.status === "confirmed" ? <StatusButton id={r.id} status="cancelled" label="Cancel" ask={`Cancel this ${one}?${r.type_id && r.resource_id && r.email ? " They are told." : ""}`} /> : null}
        </>
      }
    >
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <div class="grid gap-4 md:grid-cols-3">
        <div class="flex min-w-0 flex-col gap-4 md:col-span-2">
          <Section title="Details">
            <ReadThenEdit
              fields={[
                { label: "When", value: <><When at={r.starts_at} timeZone={timeZone} /> for {durationText(minutesOf(r))}<Overdue r={r} /></> },
                ...(r.type_name && r.title ? [{ label: "Service", value: r.type_name }] : []),
                { label: dealsCfg.one, value: r.deal_id ? <a href={`/deals/${r.deal_id}`}>{r.deal_title}</a> : null },
                { label: ownerLabel, value: r.host_name },
                { label: "Where", value: r.location ? whereText(r, { link: true, team: true }) : null },
                { label: "Email", value: r.email ? <a href={`mailto:${r.email}`} class="break-all">{r.email}</a> : null },
                { label: "Amount", value: amountOf(r) },
                ...custom,
                { label: "Their note", value: typeof theirNote === "string" && theirNote ? <span class="whitespace-pre-wrap">{theirNote}</span> : null },
                { label: "Notes", value: r.notes ? <span class="whitespace-pre-wrap">{r.notes}</span> : null },
              ]}
            >
              <form method="post" action={self} class="grid gap-3 sm:grid-cols-2">
                <EventFields r={r} choices={p.choices} deals={p.deals} dealId={r.deal_id} />
                <div class="sm:col-span-2">
                  <button class={primaryClass}>Save</button>
                </div>
              </form>
            </ReadThenEdit>
          </Section>
          {Object.keys(answers).length ? (
            <Section title="Their answers">
              <JsonData data={answers} />
            </Section>
          ) : null}
        </div>
        <div class="flex flex-col gap-4">{p.money ? <EventMoney {...p.money} /> : null}</div>
      </div>
      <RecordLine added={r.created_at} addedBy={null} changed={r.updated_at} changedBy={r.updated_by} />
    </Layout>
  );
}

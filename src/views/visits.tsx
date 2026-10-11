// Jobs, visits, appointments or events (crm.config.json's `visits` names
// them): the section on a customer's page with its add form, the list of
// what is coming up and what was done, and one visit's own page. Plain forms
// throughout, answered with a 303.
import { Section } from "../admin/detail";
import { Flash } from "../admin/flash";
import { DataTable, SearchBar, When, type TableSpec } from "../admin/list";
import { listUrl } from "../admin/query";
import { StatusBadge, type StatusOption } from "../admin/status";
import { cfg, invoicesCfg, ownerLabel, visitsCfg } from "../config";
import type { CustomField } from "../config-schema";
import type { Customer } from "../crm/customers";
import { fieldText } from "../crm/fields";
import { money, nowIn } from "../crm/text";
import { amountText, VISIT_STATUS_LABELS, VISIT_STATUSES, type OpenBooking, type Visit, type VisitFilter } from "../crm/visits";
import { Layout } from "./layout";
import { VisitMoney } from "./money";
import type { Quote } from "../invoices/quotes";
import type { Invoice } from "../invoices/invoices";
import { buttonClass, controlClass, CustomInput, Field, MESSAGES, PersonFields, primaryClass, ReadThenEdit, RecordLine, timeZone } from "./ui";

/** How many a customer's page shows. */
export const CUSTOMER_VISITS = 100;

const v = visitsCfg ?? { one: "Visit", many: "Visits", fields: [] as CustomField[], currency: "USD" };
const one = v.one.toLowerCase();
const many = v.many.toLowerCase();

export const VISIT_OPTIONS: StatusOption[] = [
  { value: "planned", label: VISIT_STATUS_LABELS.planned, tone: "strong" },
  { value: "done", label: VISIT_STATUS_LABELS.done, tone: "neutral" },
  { value: "cancelled", label: VISIT_STATUS_LABELS.cancelled, tone: "muted" },
];

/** A planned one whose time has gone by: still says Planned, and says it was not marked done. */
const overdue = (r: Visit, now = Date.now()) => r.status === "planned" && r.starts_at !== null && new Date(r.starts_at).getTime() < now;

function WhenOf({ r }: { r: Visit }) {
  if (!r.starts_at) return <span class="text-ink-3">Not scheduled</span>;
  return (
    <>
      <When at={r.starts_at} timeZone={timeZone} />
      {overdue(r) ? <span class="block text-label text-ink-3">Past due</span> : null}
    </>
  );
}

const amountOf = (r: Visit) => (r.amount_cents === null ? "" : money(r.amount_cents, r.currency ?? v.currency));

/** The custom fields that have a value, as "Truck 2 · North". */
const fieldsLine = (r: Visit) =>
  v.fields
    .map((f) => fieldText(r.fields?.[f.key]))
    .filter(Boolean)
    .join(" · ");

/** The form's own fields, for adding one and for its page. */
function VisitFields({ r, owners, defaultOwner }: { r?: Visit; owners: string[]; defaultOwner?: string | null }) {
  const at = r?.starts_at ? nowIn(timeZone, new Date(r.starts_at)) : "";
  return (
    <>
      <Field label="What" class="sm:col-span-2">
        <input name="title" value={r?.title ?? ""} required maxlength={200} placeholder={`What the ${one} is for`} class={controlClass} />
      </Field>
      <Field label="When" hint="Blank if it is not scheduled yet.">
        <input name="at" type="datetime-local" value={at} class={controlClass} />
      </Field>
      <Field label="Status">
        <select name="status" class={controlClass}>
          {VISIT_STATUSES.map((s) => (
            <option value={s} selected={s === (r?.status ?? "planned")}>
              {VISIT_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </Field>
      <Field label={ownerLabel}>
        <input name="owner" list="visit-owners" value={r ? (r.owner ?? "") : (defaultOwner ?? "")} maxlength={200} class={controlClass} />
        <datalist id="visit-owners">
          {owners.map((o) => (
            <option value={o} />
          ))}
        </datalist>
      </Field>
      <Field label={`Amount (${v.currency})`}>
        <input name="amount" inputmode="decimal" value={r ? amountText(r.amount_cents, r.currency ?? v.currency) : ""} maxlength={20} class={controlClass} />
      </Field>
      {v.fields.map((f) => (
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

/** The section on a customer's page: theirs, and a form to add one. */
export function CustomerVisits({ c, visits, owners }: { c: Customer; visits: Visit[]; owners: string[] }) {
  return (
    <div class="flex flex-col gap-4">
      {visits.length ? (
        <ol class="flex flex-col gap-3">
          {visits.map((r) => (
            <li class="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-l-2 border-line pl-3">
              <div class="min-w-0">
                <a href={`/visits/${r.id}`} class="font-semibold no-underline underline-offset-2 hover:underline">
                  {r.title}
                </a>
                <p class="text-label text-ink-2">
                  <WhenOf r={r} />
                </p>
                <p class="text-label text-ink-3">{[r.owner, amountOf(r), fieldsLine(r)].filter(Boolean).join(" · ")}</p>
              </div>
              <StatusBadge value={r.status} options={VISIT_OPTIONS} />
            </li>
          ))}
        </ol>
      ) : (
        <p class="text-ink-3">No {many} yet.</p>
      )}
      {visits.length >= CUSTOMER_VISITS ? (
        <p class="text-label text-ink-3">
          The {CUSTOMER_VISITS} most recent. The rest are in <a href={`/visits?view=all&q=${encodeURIComponent(c.name)}`}>All {many}</a>.
        </p>
      ) : null}
      <details>
        <summary class="cursor-pointer text-label font-semibold text-ink-2">Add {one}</summary>
        <form method="post" action={`/customers/${c.id}/visits`} aria-label={`Add a ${one}`} class="mt-3 grid gap-3 sm:grid-cols-2">
          <VisitFields owners={owners} defaultOwner={c.owner} />
          <div class="sm:col-span-2">
            <button class={primaryClass}>Add {one}</button>
          </div>
        </form>
      </details>
    </div>
  );
}

const VIEWS: { value: VisitFilter["view"]; label: string }[] = [
  { value: "upcoming", label: "Coming up" },
  { value: "done", label: "Done" },
  { value: "all", label: "All" },
];

export function visitSpec(): TableSpec<Visit> {
  return {
    id: "visits",
    href: (r) => `/visits/${r.id}`,
    columns: [
      {
        label: "When",
        cell: (r) => (
          <span class="whitespace-nowrap">
            <WhenOf r={r} />
            {r.status !== "planned" ? <span class="block text-label font-normal text-ink-2 sm:hidden">{VISIT_STATUS_LABELS[r.status]}</span> : null}
          </span>
        ),
      },
      {
        label: "What",
        cell: (r) => (
          <>
            {r.title}
            {fieldsLine(r) ? <span class="block text-label text-ink-2">{fieldsLine(r)}</span> : null}
          </>
        ),
      },
      {
        label: cfg.vocabulary.one,
        cell: (r) => (
          <a href={`/customers/${r.customer_id}`} class="break-words">
            {r.customer_name}
          </a>
        ),
      },
      { label: "Status", class: "hidden sm:table-cell", cell: (r) => <StatusBadge value={r.status} options={VISIT_OPTIONS} /> },
      { label: ownerLabel, class: "hidden md:table-cell", cell: (r) => r.owner ?? "" },
      { label: "Amount", class: "hidden sm:table-cell text-right", cell: (r) => <span class="whitespace-nowrap">{amountOf(r)}</span> },
    ],
  };
}

export const visitParams = (f: VisitFilter) => ({ q: f.q, view: f.view === "upcoming" ? null : f.view, owner: f.owner });

export function VisitResults(p: { filter: VisitFilter; rows: Visit[]; next: string | null; paged: boolean }) {
  const params = visitParams(p.filter);
  return (
    <div id="results">
      {p.paged ? (
        <p class="mb-3 text-label">
          <a href={listUrl("/visits", params)}>Back to the first page</a>
        </p>
      ) : null}
      <DataTable
        spec={visitSpec()}
        caption={p.filter.view === "upcoming" ? `${v.many} coming up, soonest first` : `${v.many}, newest first`}
        rows={p.rows}
        next={p.next}
        more={(cur) => listUrl("/visits", { ...params, after: cur })}
        empty={
          p.filter.owner || p.filter.q ? (
            <>
              Nothing matches here. <a href={listUrl("/visits", { view: params.view })}>Clear the search and {ownerLabel.toLowerCase()}</a>
            </>
          ) : p.filter.view === "upcoming" ? (
            `Nothing planned.`
          ) : (
            `No ${many} yet.`
          )
        }
      />
      <p class="mt-3 text-label">
        <a href={listUrl("/visits/export.csv", params)}>Export CSV</a>
      </p>
    </div>
  );
}

/** Bookings still to come that nobody made a job of yet: one click each. */
function Booked({ rows }: { rows: OpenBooking[] }) {
  if (!rows.length) return null;
  return (
    <Section title="Bookings to convert" class="mb-4">
      <ul class="flex flex-col gap-2">
        {rows.map((b) => (
          <li class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <span class="min-w-0">
              <When at={b.starts_at} timeZone={timeZone} />
              <span class="text-ink-2">
                {" "}
                {b.type_name ?? "Booking"}, {b.name}
                {b.host_name ? `, with ${b.host_name}` : ""}
              </span>{" "}
              <a href={`/bookings/${b.id}`} class="text-label">The booking</a>
            </span>
            <form method="post" action={`/bookings/${b.id}/job`}>
              {b.customer_id ? <input type="hidden" name="customer" value={b.customer_id} /> : null}
              <button class={buttonClass}>Create {one}</button>
            </form>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function VisitsPage(p: {
  user: string;
  booked: OpenBooking[];
  owners: string[];
  filter: VisitFilter;
  rows: Visit[];
  next: string | null;
  paged: boolean;
  flash: { code?: string | null; n?: string | null };
}) {
  const owners = [...new Set([p.user, ...p.owners])];
  return (
    <Layout title={v.many} user={p.user} section="visits"
      actions={<a href="/visits/new" class={primaryClass}>New {one}</a>}>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <SearchBar
        action="/visits"
        target="#results"
        q={p.filter.q}
        placeholder={`What, or a ${cfg.vocabulary.one.toLowerCase()}'s name`}
        filters={[
          { name: "view", label: "Show", options: VIEWS.filter((x) => x.value !== "upcoming"), value: p.filter.view === "upcoming" ? null : p.filter.view, any: "Coming up" },
          {
            name: "owner",
            label: ownerLabel,
            options: owners.map((o) => ({ value: o, label: o === p.user ? `${o} (me)` : o })),
            value: p.filter.owner,
            any: "Anyone",
          },
        ]}
      />
      {p.filter.view === "upcoming" && !p.paged ? <Booked rows={p.booked} /> : null}
      <VisitResults filter={p.filter} rows={p.rows} next={p.next} paged={p.paged} />
    </Layout>
  );
}

/** A new one from the list: the person (matched by email or phone, or added) and the visit. */
export function NewVisitPage(p: { user: string; owners: string[]; flash: { code?: string | null; n?: string | null } }) {
  return (
    <Layout title={`New ${one}`} user={p.user} section="visits" back={{ href: "/visits", label: v.many }}>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <form method="post" action="/visits" class="grid max-w-3xl gap-3 rounded-card border border-line bg-surface shadow-card p-4 sm:grid-cols-2">
        <PersonFields />
        <VisitFields owners={p.owners} defaultOwner={p.user} />
        <div class="sm:col-span-2">
          <button class={primaryClass}>Add {one}</button>
          <span class="ml-3 text-label text-ink-3">Someone already here by email or phone gets it; anyone else is added.</span>
        </div>
      </form>
    </Layout>
  );
}

/** One visit: what, when and for whom at the top, its details with Edit, its quote and invoice. */
export function VisitPage(p: {
  user: string; visit: Visit; owners: string[]; money: { quotes: Quote[]; invoices: Invoice[] } | null; flash: { code?: string | null; n?: string | null };
}) {
  const r = p.visit;
  const self = `/visits/${r.id}`;
  const doc = {
    email: r.customer_email, name: r.customer_name, phone: r.customer_phone, visit: r.id, line: r.title,
    unit: r.amount_cents === null ? null : amountText(r.amount_cents, r.currency ?? v.currency),
    currency: r.amount_cents === null ? null : r.currency,
  };
  const custom = v.fields.map((f) => ({ label: f.label, value: fieldText(r.fields?.[f.key]) || null }));
  return (
    <Layout
      title={r.title}
      user={p.user}
      section="visits"
      back={{ href: "/visits", label: v.many }}
      sub={
        <p class="flex flex-wrap items-center gap-x-2">
          <StatusBadge value={r.status} options={VISIT_OPTIONS} />
          <a href={`/customers/${r.customer_id}`}>{r.customer_name}</a>
          {r.customer_phone ? <><span aria-hidden="true">·</span><a href={`tel:${r.customer_phone.replace(/[^0-9+]/g, "")}`} class="whitespace-nowrap text-ink-2">{r.customer_phone}</a></> : null}
        </p>
      }
      actions={
        <>
          {r.status === "planned" ? (
            <form method="post" action={`${self}/status`}>
              <input type="hidden" name="status" value="done" />
              <input type="hidden" name="return" value={self} />
              <button class={buttonClass}>Mark done</button>
            </form>
          ) : null}
          {invoicesCfg ? <a href={listUrl("/invoices/quotes/new", doc)} class={buttonClass}>Quote this {one}</a> : null}
          {invoicesCfg ? <a href={listUrl("/invoices/new", doc)} class={buttonClass}>Invoice this {one}</a> : null}
        </>
      }
    >
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <div class="grid gap-4 md:grid-cols-3">
        <div class="min-w-0 md:col-span-2">
          <Section title="Details">
            <ReadThenEdit
              fields={[
                { label: "When", value: <WhenOf r={r} /> },
                { label: ownerLabel, value: r.owner },
                { label: "Amount", value: amountOf(r) },
                ...custom,
                { label: "Notes", value: r.notes ? <span class="whitespace-pre-wrap">{r.notes}</span> : null },
              ]}
            >
              <form method="post" action={self} class="grid gap-3 sm:grid-cols-2">
                <VisitFields r={r} owners={p.owners} />
                <div class="sm:col-span-2">
                  <button class={primaryClass}>Save</button>
                </div>
              </form>
            </ReadThenEdit>
          </Section>
        </div>
        <div class="flex flex-col gap-4">{p.money ? <VisitMoney {...p.money} /> : null}</div>
      </div>
      <RecordLine added={r.created_at} addedBy={r.created_by} changed={r.updated_at} changedBy={r.updated_by} />
    </Layout>
  );
}

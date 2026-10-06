// Jobs, visits, appointments or events (crm.config.json's `visits` names
// them): the section on a customer's page with its add form, the list of
// what is coming up and what was done, and one visit's own page. Plain forms
// throughout, answered with a 303.
import { FieldList, Section } from "../admin/detail";
import { Flash } from "../admin/flash";
import { DataTable, SearchBar, When, type TableSpec } from "../admin/list";
import { listUrl } from "../admin/query";
import { StatusBadge, StatusForm, type StatusOption } from "../admin/status";
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
import { buttonClass, controlClass, CustomInput, Field, MESSAGES, primaryClass, timeZone, Who } from "./ui";

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
      {overdue(r) ? <span class="block text-label text-ink-3">Not marked done</span> : null}
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
      <Field label="When" hint={`In ${timeZone}. Leave it empty if it is not scheduled yet.`}>
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
      <details open={!visits.length}>
        <summary class="cursor-pointer text-label font-semibold text-ink-2">Add a {one}</summary>
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
            `Nothing planned. Add a ${one} from a ${cfg.vocabulary.one.toLowerCase()}'s page.`
          ) : (
            `No ${many} yet. Add one from a ${cfg.vocabulary.one.toLowerCase()}'s page.`
          )
        }
      />
      <p class="mt-3 text-label">
        <a href={listUrl("/visits/export.csv", params)}>Export these as CSV</a>
      </p>
    </div>
  );
}

/** Bookings still to come that nobody made a job of yet: one click each. */
function Booked({ rows }: { rows: OpenBooking[] }) {
  if (!rows.length) return null;
  return (
    <Section title={`Booked, not a ${one} yet`} class="mb-4">
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
              <button class={buttonClass}>Make it a {one}</button>
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
    <Layout title={v.many} user={p.user} section="visits">
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

/** One visit: the whole form, its status on its own, who added and changed it. */
export function VisitPage(p: {
  user: string; visit: Visit; owners: string[]; money: { quotes: Quote[]; invoices: Invoice[] } | null; flash: { code?: string | null; n?: string | null };
}) {
  const r = p.visit;
  const self = `/visits/${r.id}`;
  return (
    <Layout title={r.title} user={p.user} section="visits">
      <p class="mb-3 text-label">
        <a href={`/customers/${r.customer_id}`}>{r.customer_name}</a>
        <span class="text-ink-3"> · </span>
        <a href="/visits">All {many}</a>
      </p>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span class="flex items-center gap-2">
          <span class="text-label text-ink-2" aria-hidden="true">
            Status
          </span>
          <StatusForm action={`${self}/status`} current={r.status} options={VISIT_OPTIONS} returnTo={self} label="Status" />
        </span>
        {r.customer_phone ? <a href={`tel:${r.customer_phone.replace(/[^0-9+]/g, "")}`}>Call {r.customer_phone}</a> : null}
        {invoicesCfg ? (
          <a href={listUrl("/invoices/quotes/new", {
            email: r.customer_email, name: r.customer_name, phone: r.customer_phone, visit: r.id, line: r.title,
            unit: r.amount_cents === null ? null : amountText(r.amount_cents, r.currency ?? v.currency),
            currency: r.amount_cents === null ? null : r.currency,
          })}>Quote this {one}</a>
        ) : null}
        {invoicesCfg ? (
          <a href={listUrl("/invoices/new", {
            email: r.customer_email, name: r.customer_name, phone: r.customer_phone, visit: r.id, line: r.title,
            unit: r.amount_cents === null ? null : amountText(r.amount_cents, r.currency ?? v.currency),
            currency: r.amount_cents === null ? null : r.currency,
          })}>Invoice this {one}</a>
        ) : null}
      </div>
      <div class="grid gap-4 md:grid-cols-3">
        <div class="min-w-0 md:col-span-2">
          <Section title="Details">
            <form method="post" action={self} class="grid gap-3 sm:grid-cols-2">
              <VisitFields r={r} owners={p.owners} />
              <div class="sm:col-span-2">
                <button class={primaryClass}>Save</button>
              </div>
            </form>
          </Section>
        </div>
        <div class="flex flex-col gap-4">
          {p.money ? <VisitMoney {...p.money} /> : null}
          <Section title="Record">
            <FieldList
              fields={[
                { label: "Added", value: <Who at={r.created_at} by={r.created_by} /> },
                { label: "Changed", value: <Who at={r.updated_at} by={r.updated_by} /> },
              ]}
            />
            <p class="mt-3 text-label text-ink-3">Cancel rather than delete: a cancelled {one} stays on the record.</p>
          </Section>
        </div>
      </div>
    </Layout>
  );
}

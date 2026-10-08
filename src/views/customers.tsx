// The customers list: search and filters (htmx as you type, a plain GET
// without it), keyset Load more, CSV of the current filter, and a form to
// add one by hand.
import { Flash } from "../admin/flash";
import { DataTable, SearchBar, When, type TableSpec } from "../admin/list";
import { listUrl } from "../admin/query";
import { StatusBadge } from "../admin/status";
import { cfg, ownerLabel, vocab } from "../config";
import type { Customer, ListFilter } from "../crm/customers";
import type { Stage } from "../crm/stages";
import { Layout } from "./layout";
import { controlClass, DueMark, Field, MESSAGES, primaryClass, stageOptions, timeZone } from "./ui";

/** Each row's next follow-up (by customer id), and today in the business's zone: what the Next column says. */
export type NextOf = { next: Map<string, { due_on: string; due_time: string | null }>; today: string };

export function filterParams(f: ListFilter) {
  return { q: f.q, stage: f.stage, tag: f.tag, owner: f.owner, show: f.archived ? "archived" : null };
}

export function customerSpec(stages: Stage[], n: NextOf): TableSpec<Customer> {
  const options = stageOptions(stages);
  return {
    id: "customers",
    href: (r) => `/customers/${r.id}`,
    columns: [
      {
        label: "Name",
        cell: (r) => (
          <>
            {r.name}
            {r.phone || r.email ? <span class="block break-words text-label font-normal text-ink-2 sm:hidden">{r.phone || r.email}</span> : null}
          </>
        ),
      },
      { label: "Status", cell: (r) => <StatusBadge value={r.stage} options={options} /> },
      { label: "Next follow-up", class: "hidden sm:table-cell", cell: (r) => <DueMark next={n.next.get(r.id)} today={n.today} /> },
      {
        label: "Contact",
        class: "hidden sm:table-cell",
        cell: (r) => (
          <span class="wrap-anywhere text-ink-2">
            {[r.email, r.phone].filter(Boolean).join(" · ")}
          </span>
        ),
      },
      { label: "Company", class: "hidden wrap-anywhere md:table-cell", cell: (r) => r.company ?? "" },
      { label: "Tags", class: "hidden lg:table-cell", cell: (r) => (r.tags.length ? <span class="text-ink-2">{r.tags.join(", ")}</span> : "") },
      { label: ownerLabel, class: "hidden lg:table-cell", cell: (r) => r.owner ?? "" },
      { label: "Last contact", class: "hidden md:table-cell", cell: (r) => <When at={r.last_contact_at} timeZone={timeZone} /> },
    ],
  };
}

export function Results(p: { stages: Stage[]; filter: ListFilter; rows: Customer[]; next: string | null; paged: boolean; nextOf: NextOf }) {
  const params = filterParams(p.filter);
  const self = listUrl("/customers", params);
  const filtered = !!(p.filter.q || p.filter.stage || p.filter.tag || p.filter.owner);
  return (
    <div id="results">
      {p.paged ? (
        <p class="mb-3 text-label">
          <a href={self}>Back to the first page</a>
        </p>
      ) : null}
      <DataTable
        spec={customerSpec(p.stages, p.nextOf)}
        caption={`${vocab.many}, most recently changed first`}
        rows={p.rows}
        next={p.next}
        more={(cur) => listUrl("/customers", { ...params, after: cur })}
        empty={
          filtered ? (
            <>
              Nothing matches these filters. <a href="/customers">Clear filters</a>
            </>
          ) : p.filter.archived ? (
            "Nothing is archived."
          ) : (
            `No ${vocab.many.toLowerCase()} yet. Add one below, add people from What came in, or import a spreadsheet.`
          )
        }
      />
      <p class="mt-3 text-label">
        <a href={listUrl("/customers/export.csv", params)}>Export these as CSV</a>
      </p>
    </div>
  );
}

export function CustomersPage(p: {
  user: string;
  stages: Stage[];
  facets: { tags: string[]; owners: string[] };
  filter: ListFilter;
  rows: Customer[];
  next: string | null;
  paged: boolean;
  nextOf: NextOf;
  flash: { code?: string | null; n?: string | null };
}) {
  const owners = [...new Set([p.user, ...p.facets.owners])];
  return (
    <Layout title={vocab.many} user={p.user} section="customers">
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <SearchBar
        action="/customers"
        target="#results"
        q={p.filter.q}
        placeholder="Name, email, phone or company"
        filters={[
          { name: "stage", label: "Status", options: p.stages.map((s) => ({ value: s.key, label: s.label })), value: p.filter.stage, any: "Any status" },
          ...(p.facets.tags.length ? [{ name: "tag", label: "Tag", options: p.facets.tags.map((t) => ({ value: t, label: t })), value: p.filter.tag, any: "Any tag" }] : []),
          {
            name: "owner",
            label: ownerLabel,
            options: owners.map((o) => ({ value: o, label: o === p.user ? `${o} (me)` : o })),
            value: p.filter.owner,
            any: "Anyone",
          },
          { name: "show", label: "Show", options: [{ value: "archived", label: "Archived" }], value: p.filter.archived ? "archived" : null, any: "Active" },
        ]}
      />
      <Results stages={p.stages} filter={p.filter} rows={p.rows} next={p.next} paged={p.paged} nextOf={p.nextOf} />
      <NewCustomer stages={p.stages} />
    </Layout>
  );
}

function NewCustomer({ stages }: { stages: Stage[] }) {
  const open = stages.filter((s) => s.kind === "open");
  return (
    <section class="mt-6 rounded-card border border-line bg-surface p-4" aria-labelledby="new-customer">
      <h2 id="new-customer" class="mb-3 text-label font-semibold text-ink-2">
        New {vocab.one.toLowerCase()}
      </h2>
      <form method="post" action="/customers" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Name">
          <input name="name" maxlength={200} autocomplete="off" class={controlClass} />
        </Field>
        <Field label="Email">
          <input name="email" type="email" maxlength={254} autocomplete="off" class={controlClass} />
        </Field>
        <Field label="Phone">
          <input name="phone" type="tel" maxlength={40} autocomplete="off" class={controlClass} />
        </Field>
        <Field label="Company">
          <input name="company" maxlength={200} autocomplete="off" class={controlClass} />
        </Field>
        <Field label="Status">
          <select name="stage" class={controlClass}>
            {(open.length ? open : stages).map((s) => (
              <option value={s.key}>{s.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Source">
          <input name="source" list="sources" maxlength={100} class={controlClass} />
          <datalist id="sources">
            {cfg.sources.map((s) => (
              <option value={s} />
            ))}
          </datalist>
        </Field>
        <div class="sm:col-span-2 lg:col-span-3">
          <button class={primaryClass}>Add {vocab.one.toLowerCase()}</button>
          <span class="ml-3 text-label text-ink-3">A name, an email or a phone is enough. Someone already here by email or phone opens instead.</span>
        </div>
      </form>
    </section>
  );
}

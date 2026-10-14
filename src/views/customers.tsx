// The customers list: search and filters (htmx as you type, a plain GET
// without it), keyset Load more, CSV of the current filter, and a form to
// a page to add one by hand.
import { Flash } from "../admin/flash";
import { DataTable, EmptyState, NoMatches, SearchBar, When, type TableSpec } from "../admin/list";
import { listUrl } from "../admin/query";
import { StatusBadge } from "../admin/status";
import { cfg, dealsCfg, eventsCfg, ownerLabel, vocab } from "../config";
import type { Customer, ListFilter } from "../crm/customers";
import type { Stage } from "../crm/stages";
import { Layout } from "./layout";
import { Avatar, buttonClass, controlClass, DueMark, Field, MESSAGES, primaryClass, stageOptions, timeZone } from "./ui";
import { ownerOptions, personName } from "../crm/people";

/** Each row's next task (by customer id), who is still in play, and today in the business's zone: what the Next column says. */
export type NextOf = { next: Map<string, { due_on: string; due_time: string | null }>; inPlay: Set<string>; today: string };

export function filterParams(f: ListFilter) {
  return { q: f.q, stage: f.stage, tag: f.tag, owner: f.owner, next: f.unplanned ? "none" : null, show: f.archived ? "archived" : null };
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
          <span class="flex min-w-48 items-center gap-3">
            <Avatar name={r.name} />
            <span class="min-w-0">
              <span class="block break-words font-medium">{r.name}</span>
              {r.company ? <span class="block break-words text-label font-normal text-ink-3">{r.company}</span> : null}
              {r.phone || r.email ? <span class="block break-words text-label font-normal text-ink-3 sm:hidden">{r.phone || r.email}</span> : null}
            </span>
          </span>
        ),
      },
      { label: "Status", cell: (r) => <StatusBadge value={r.stage} options={options} /> },
      { label: "Next task", class: "hidden sm:table-cell", cell: (r) => (n.next.has(r.id) || n.inPlay.has(r.id) ? <DueMark next={n.next.get(r.id)} today={n.today} /> : "") },
      // One line each, so every row is the same height, as Catalyst's and Stripe's tables keep them.
      { label: "Email", class: "hidden md:table-cell", cell: (r) => (r.email ? <span class="block max-w-64 truncate text-ink-2" title={r.email}>{r.email}</span> : "") },
      { label: "Phone", class: "hidden 2xl:table-cell", cell: (r) => (r.phone ? <span class="whitespace-nowrap text-ink-2 tabular-nums">{r.phone}</span> : "") },
      { label: ownerLabel, class: "hidden lg:table-cell", cell: (r) => (r.owner ? <span class="flex items-center gap-2 whitespace-nowrap"><Avatar name={personName(r.owner)} size="sm" />{personName(r.owner)}</span> : "") },
      { label: "Last contact", class: "hidden lg:table-cell", cell: (r) => <span class="whitespace-nowrap">{r.last_contact_at ? <When at={r.last_contact_at} timeZone={timeZone} day /> : <span class="text-ink-3">Added <When at={r.created_at} timeZone={timeZone} day /></span>}</span> },
    ],
  };
}

export function Results(p: { stages: Stage[]; filter: ListFilter; rows: Customer[]; next: string | null; paged: boolean; nextOf: NextOf }) {
  const params = filterParams(p.filter);
  const self = listUrl("/customers", params);
  const narrowed = !!(p.filter.q || p.filter.stage || p.filter.tag || p.filter.owner);
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
          p.filter.unplanned && !narrowed ? (
            <EmptyState title="Everyone has something planned.">Every open lead and {dealsCfg.one.toLowerCase()} has a task or a {eventsCfg ? eventsCfg.one.toLowerCase() : "event"} planned.</EmptyState>
          ) : narrowed || p.filter.unplanned ? (
            <NoMatches clear="/customers" />
          ) : p.filter.archived ? (
            "Nothing is archived."
          ) : (
            <EmptyState title={`No ${vocab.many.toLowerCase()} yet.`} action={<a href="/customers/new" class={primaryClass}>New {vocab.one.toLowerCase()}</a>}>
              Add one here, or ask the AI to import your spreadsheet. Everyone who fills in a form or books online is added as they do.
            </EmptyState>
          )
        }
      />
      <p class="mt-3 text-label">
        <a href={listUrl("/customers/export.csv", params)}>Export CSV</a>
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
  return (
    <Layout title={vocab.many} user={p.user} section="customers"
      actions={<><a href="/stages#customers-list" class={buttonClass}>Edit statuses</a><a href="/customers/new" class={primaryClass}>New {vocab.one.toLowerCase()}</a></>}>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <SearchBar
        action="/customers"
        target="#results"
        q={p.filter.q}
        placeholder={`Search ${vocab.many.toLowerCase()}`}
        filters={[
          { name: "stage", label: "Status", options: p.stages.map((s) => ({ value: s.key, label: s.label })), value: p.filter.stage, any: "Any status" },
          ...(p.facets.tags.length ? [{ name: "tag", label: "Tag", options: p.facets.tags.map((t) => ({ value: t, label: t })), value: p.filter.tag, any: "Any tag" }] : []),
          {
            name: "owner",
            label: ownerLabel,
            options: ownerOptions(p.user, p.facets.owners),
            value: p.filter.owner,
            any: "Anyone",
          },
          // As Pipedrive marks a deal with no activity: the ones in play with nothing planned next.
          { name: "next", label: "Next task", options: [{ value: "none", label: "Nothing planned" }], value: p.filter.unplanned ? "none" : null, any: "Any next task" },
          { name: "show", label: "Show", options: [{ value: "archived", label: "Archived" }], value: p.filter.archived ? "archived" : null, any: "Active" },
        ]}
      />
      <Results stages={p.stages} filter={p.filter} rows={p.rows} next={p.next} paged={p.paged} nextOf={p.nextOf} />
    </Layout>
  );
}

/** Add one by hand: who they are, their status and where they came from. */
export function NewCustomerPage({ user, stages, flash }: { user: string; stages: Stage[]; flash: { code?: string | null; n?: string | null } }) {
  const open = stages.filter((s) => s.kind === "open");
  return (
    <Layout title={`New ${vocab.one.toLowerCase()}`} user={user} section="customers" back={{ href: "/customers", label: vocab.many }}>
      <Flash code={flash.code} n={flash.n} messages={MESSAGES} />
      <form method="post" action="/customers" class="grid max-w-3xl gap-3 rounded-card border border-line bg-surface shadow-card p-4 sm:grid-cols-2">
        <Field label="Name">
          <input name="name" maxlength={200} autocomplete="off" autofocus class={controlClass} />
        </Field>
        <Field label="Company">
          <input name="company" maxlength={200} autocomplete="off" class={controlClass} />
        </Field>
        <Field label="Email">
          <input name="email" type="email" maxlength={254} autocomplete="off" class={controlClass} />
        </Field>
        <Field label="Phone">
          <input name="phone" type="tel" maxlength={40} autocomplete="off" class={controlClass} />
        </Field>
        <Field label="Address">
          <input name="address" maxlength={500} autocomplete="off" class={controlClass} />
        </Field>
        <Field label="Status">
          {/* Every status, the first open one chosen: someone already a customer can be added as one. */}
          <select name="stage" class={controlClass}>
            {stages.map((s) => (
              <option value={s.key} selected={s.key === (open[0] ?? stages[0])?.key}>{s.label}</option>
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
        <div class="sm:col-span-2">
          <button class={primaryClass}>Create {vocab.one.toLowerCase()}</button>
          <span class="ml-3 text-label text-ink-3">A name, email or phone is enough. Someone already here opens their record.</span>
        </div>
      </form>
    </Layout>
  );
}

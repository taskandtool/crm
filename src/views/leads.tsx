// Leads, as Pipedrive's Leads Inbox and Jobber's Requests: every enquiry, open
// until it is converted to a deal or archived with a reason
// (docs/plans/crm-contacts-leads-deals.md). The list (Open, Converted,
// Archived), a lead's page, and New lead for a phone call.
import type { Child } from "hono/jsx";
import { FieldList, Section } from "../admin/detail";
import { Flash } from "../admin/flash";
import { EmptyState, rowClick, SearchBar, When } from "../admin/list";
import { listUrl } from "../admin/query";
import { StatusBadge, type StatusOption } from "../admin/status";
import type { Note } from "../customers/notes";
import { dealsCfg, vocab } from "../config";
import { ARCHIVE_REASONS, MANUAL_SOURCES, SOURCE_LABELS, sourceText, type Lead, type LeadStatus } from "../crm/leads";
import { ownerOptions, ownerSuggestions, personName } from "../crm/people";
import type { Task } from "../crm/tasks";
import { Layout } from "./layout";
import { TasksSection } from "./tasks";
import { ActivitySection, AddToggle, ArchivedNote, Avatar, buttonClass, ContactCard, controlClass, Field, MESSAGES, ReadThenEdit, PersonFields, primaryClass, timeZone, ViewLink, viewsClass } from "./ui";

const LEAD_TONES: StatusOption[] = [
  { value: "open", label: "Open", tone: "accent" },
  { value: "converted", label: "Converted", tone: "strong" },
  { value: "archived", label: "Archived", tone: "muted" },
];
const TABS: { value: LeadStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "converted", label: "Converted" },
  { value: "archived", label: "Archived" },
];
const deal = dealsCfg.one.toLowerCase();

export type LeadFilter = { status: LeadStatus; q: string | null; source: string | null; owner: string | null };
const params = (f: LeadFilter) => ({ status: f.status === "open" ? null : f.status, q: f.q, source: f.source, owner: f.owner });

/** What a lead's contact already has, as links: their open deal, their next visit. */
function Context({ l }: { l: Lead }) {
  if (!l.open_deal_id && !l.next_event_id) return null;
  return (
    <p class="mt-1.5 flex flex-wrap gap-x-3 text-label">
      {l.open_deal_id ? <a href={`/deals/${l.open_deal_id}`}>Open {deal}: {l.open_deal_title}</a> : null}
      {l.next_event_id ? <a href={`/events/${l.next_event_id}`}>Visit <When at={l.next_event_at} timeZone={timeZone} /></a> : null}
    </p>
  );
}

/** Archive, asking why, as HubSpot's Disqualification reason: a menu of the reasons. */
function ArchiveMenu({ l, returnTo }: { l: Lead; returnTo: string }) {
  return (
    <details data-menu class="relative">
      <summary class={buttonClass + " cursor-pointer list-none"} aria-label={`Archive ${l.customer_name}'s lead`}>Archive</summary>
      <div class="absolute right-0 z-10 mt-1 w-44 rounded-control bg-surface p-1 shadow-lift ring-1 ring-line">
        <p class="px-2.5 py-1 text-label text-ink-3">Why?</p>
        {ARCHIVE_REASONS.map((reason) => (
          <form method="post" action={`/leads/${l.id}/archive`}>
            <input type="hidden" name="reason" value={reason} />
            <input type="hidden" name="return" value={returnTo} />
            <button class="w-full rounded-control px-2.5 py-1.5 text-left font-medium hover:bg-panel focus-visible:outline-2 focus-visible:outline-accent">{reason}</button>
          </form>
        ))}
      </div>
    </details>
  );
}

/** What to do with an open lead, as Pipedrive's lead: Archive (asking why), then Convert to deal (the New deal form, filled in), the one primary, last. */
function Actions({ l, returnTo }: { l: Lead; returnTo: string }) {
  if (l.status !== "open") return null;
  return (
    <>
      <ArchiveMenu l={l} returnTo={returnTo} />
      <a href={`/deals/new?from=lead.${l.id}`} class={primaryClass}>Convert to {deal}</a>
    </>
  );
}

/** One lead: the row opens it, where Convert and Archive are, as every list here opens its record. */
function Row({ l }: { l: Lead }) {
  return (
    <li {...rowClick(`/leads/${l.id}`)} class="flex cursor-pointer flex-col gap-3 border-b border-line py-4 hover:bg-canvas/60 sm:flex-row sm:items-start sm:gap-4">
      <div class="flex min-w-0 flex-1 gap-3">
        <Avatar name={l.customer_name} />
        <div class="min-w-0 flex-1">
          <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <a href={`/leads/${l.id}`} class="font-medium text-ink no-underline hover:underline">{l.customer_name}</a>
            {l.status === "open" ? null : <StatusBadge value={l.status} options={LEAD_TONES} />}
          </p>
          <p class="mt-0.5 flex flex-wrap gap-x-1.5 text-label text-ink-3">
            <span class="font-medium text-ink-2">{sourceText(l)}</span>
            <span aria-hidden="true">·</span>
            <When at={l.created_at} timeZone={timeZone} />
            {l.owner ? <><span aria-hidden="true">·</span><span>{personName(l.owner)}</span></> : null}
          </p>
          {l.said ? <p class="mt-1.5 line-clamp-2 break-words text-ink-2">{l.said}</p> : null}
          {l.status === "converted" && l.deal_id ? <p class="mt-1.5 text-label"><a href={`/deals/${l.deal_id}`}>Converted to {l.deal_title}</a></p> : null}
          {l.status === "archived" ? <p class="mt-1.5 text-label text-ink-3">Archived: {l.archived_reason}</p> : null}
          {l.status === "open" ? <Context l={l} /> : null}
        </div>
      </div>
    </li>
  );
}

/** Everything under the filter. Also the htmx answer to the filter. */
export function LeadResults({ filter, rows }: { filter: LeadFilter; rows: Lead[] }) {
  const narrowed = !!(filter.q || filter.source || filter.owner);
  return (
    <div id="results">
      {rows.length ? (
        <ol class="flex flex-col border-t border-line">{rows.map((l) => <Row l={l} />)}</ol>
      ) : (
        <div class="border-t border-line py-10">
          {narrowed ? (
            <EmptyState title="No leads match." action={<a href={listUrl("/leads", { status: params(filter).status })} class={buttonClass}>Clear filters</a>} />
          ) : filter.status === "open" ? (
            <EmptyState title="No open leads." action={<a href="/leads/new" class={buttonClass}>New lead</a>}>
              Website form entries and online bookings appear here. Use New lead to add someone who called or walked in.
            </EmptyState>
          ) : (
            <EmptyState title={filter.status === "converted" ? `None converted to a ${deal} yet.` : "Nothing archived."} />
          )}
        </div>
      )}
    </div>
  );
}

export function LeadsPage(p: { user: string; filter: LeadFilter; rows: Lead[]; owners: string[]; flash: { code?: string | null; n?: string | null }; undo: string | null }) {
  const f = p.filter;
  const self = listUrl("/leads", params(f));
  return (
    <Layout title="Leads" user={p.user} section="leads" actions={<a href="/leads/new" class={primaryClass}>New lead</a>}>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} action={p.undo && p.flash.code === "lead-archived" ? (
        <form method="post" action={`/leads/${p.undo}/reopen`}>
          <input type="hidden" name="return" value={self} />
          <button class="font-semibold text-accent hover:underline">Undo</button>
        </form>
      ) : null} />
      <nav aria-label="Which leads" class={"mb-4 " + viewsClass}>
        {TABS.map((t) => (
          <ViewLink href={listUrl("/leads", { ...params(f), status: t.value === "open" ? null : t.value })} on={f.status === t.value}>{t.label}</ViewLink>
        ))}
      </nav>
      <SearchBar
        action="/leads"
        target="#results"
        q={f.q}
        placeholder="Search leads"
        keep={{ status: params(f).status }}
        filters={[
          { name: "source", label: "Source", options: Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label })), value: f.source, any: "Any source" },
          { name: "owner", label: "Owner", options: ownerOptions(p.user, p.owners), value: f.owner, any: "Anyone" },
        ]}
      />
      <LeadResults filter={f} rows={p.rows} />
    </Layout>
  );
}

/** The submission's answers as label and value, the hidden ones (`_utm`, `_consent`) left out. */
function answersOf(l: Lead) {
  return Object.entries(l.answers ?? {})
    .filter(([k, v]) => !k.startsWith("_") && v !== null && v !== "")
    .map(([k, v]) => ({ label: k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), value: typeof v === "string" ? <span class="whitespace-pre-wrap">{v}</span> : JSON.stringify(v) }));
}

export function LeadPage(p: {
  user: string;
  lead: Lead;
  tasks: { open: Task[]; done: Task[] };
  notes: Note[];
  owners: string[];
  today: string;
  flash: { code?: string | null; n?: string | null };
}) {
  const l = p.lead;
  const self = `/leads/${l.id}`;
  const answers = answersOf(l);
  return (
    <Layout title={l.customer_name} user={p.user} section="leads" back={{ href: "/leads", label: "Leads" }}
      sub={<span class="flex flex-wrap items-center gap-x-2 gap-y-1"><StatusBadge value={l.status} options={LEAD_TONES} />{sourceText(l)} · <When at={l.created_at} timeZone={timeZone} /></span>}
      // As Pipedrive's lead: Convert and Archive. Reaching them is the contact card's.
      // Archived, it is off to the list with Undo, as an archived lead leaves Pipedrive's inbox.
      actions={<Actions l={l} returnTo="/leads" />}>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      {l.status === "converted" && l.deal_id ? <p role="status" class="mb-4 rounded-card border border-line bg-panel px-4 py-2">Converted to <a href={`/deals/${l.deal_id}`}>{l.deal_title}</a>.</p> : null}
      {l.status === "archived" ? <ArchivedNote action={`${self}/reopen`} fields={{ return: self }}>Archived: {l.archived_reason}.</ArchivedNote> : null}
      <div class="grid gap-4 md:grid-cols-3">
        <div class="flex min-w-0 flex-col gap-4 md:col-span-2">
          <Section title="What they said">
            {answers.length ? <FieldList fields={answers} />
              : l.said ? <p class="whitespace-pre-wrap">{l.said}</p>
              : l.source === "booking" ? <p>Booked {l.title} online.</p>
              : <p class="text-ink-3">Nothing written.</p>}
            {l.booking_id ? <p class="mt-3 text-label"><a href={`/events/${l.booking_id}`}>The booking →</a></p> : null}
            {l.submission_id ? <p class="mt-3 text-label"><a href={`/forms/submissions/${l.submission_id}`}>The form submission →</a></p> : null}
          </Section>
          <Section title="Tasks" count={p.tasks.open.length}>
            <TasksSection customerId={l.customer_id} open={p.tasks.open} done={p.tasks.done}
              deals={l.open_deal_id ? [{ id: l.open_deal_id, title: l.open_deal_title ?? "" }] : []}
              owners={p.owners} user={p.user} today={p.today} returnTo={self} />
          </Section>
          <ActivitySection action={`${self}/notes`} notes={p.notes} />
        </div>
        <div class="flex flex-col gap-4">
          {/* The lead's own details apart from the person's, as Pipedrive's lead view keeps them. */}
          <Section title="Details">
            <ReadThenEdit fields={[
              { label: "What they need", value: l.title },
              { label: "Owner", value: l.owner ? personName(l.owner) : null },
              { label: "Source", value: SOURCE_LABELS[l.source] },
            ]}>
              <form method="post" action={self} class="grid gap-3">
                <Field label="What they need">
                  <input name="title" value={l.title} required maxlength={200} class={controlClass} />
                </Field>
                <Field label="Owner">
                  <input name="owner" list="lead-owners" value={l.owner ? personName(l.owner) : ""} maxlength={200} class={controlClass} />
                  <datalist id="lead-owners">{ownerSuggestions(p.owners).map((o) => <option value={o} />)}</datalist>
                </Field>
                <Field label="Notes">
                  <textarea name="notes" rows={3} maxlength={10000} class={controlClass}>{l.notes ?? ""}</textarea>
                </Field>
                <div><button class={buttonClass}>Save</button></div>
              </form>
            </ReadThenEdit>
          </Section>
          <ContactCard id={l.customer_id} name={l.customer_name} phone={l.customer_phone} email={l.customer_email} more={[
            { label: `Open ${deal}`, value: l.open_deal_id ? <a href={`/deals/${l.open_deal_id}`}>{l.open_deal_title}</a> : null },
            { label: "Next visit", value: l.next_event_id ? <a href={`/events/${l.next_event_id}`}><When at={l.next_event_at} timeZone={timeZone} /></a> : null },
          ]} />
        </div>
      </div>
      <p class="mt-6 border-t border-line pt-3 text-label text-ink-3">Added <When at={l.created_at} timeZone={timeZone} day />{l.created_by ? ` by ${personName(l.created_by)}` : ""}</p>
    </Layout>
  );
}

/** New lead: a phone call or a walk-in, as Pipedrive's + Lead and Jobber's New request. */
export function NewLeadPage(p: { user: string; owners: string[]; flash: { code?: string | null; n?: string | null } }) {
  return (
    <Layout title="New lead" user={p.user} section="leads" back={{ href: "/leads", label: "Leads" }}>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <form method="post" action="/leads" class="grid max-w-3xl gap-3 rounded-card border border-line bg-surface p-4 shadow-card sm:grid-cols-2">
        <PersonFields pairs />
        <Field label="What they need" class="sm:col-span-2">
          <input name="title" required maxlength={200} placeholder="New furnace" class={controlClass} />
        </Field>
        <Field label="Source">
          <select name="source" class={controlClass}>
            {MANUAL_SOURCES.map((s) => <option value={s}>{SOURCE_LABELS[s]}</option>)}
          </select>
        </Field>
        <Field label="Owner">
          <input name="owner" list="lead-owners" value={personName(p.user)} maxlength={200} class={controlClass} />
          <datalist id="lead-owners">{ownerSuggestions(p.owners).map((o) => <option value={o} />)}</datalist>
        </Field>
        <Field label="Notes" class="sm:col-span-2">
          <textarea name="notes" rows={3} maxlength={10000} placeholder="What they said on the call" class={controlClass}></textarea>
        </Field>
        <div class="sm:col-span-2 flex flex-wrap items-center gap-3">
          <button class={primaryClass}>Create lead</button>
          <span class="text-label text-ink-3">An email or phone that is already here adds the lead to that {vocab.one.toLowerCase()}.</span>
        </div>
      </form>
    </Layout>
  );
}

/** A contact's page's Leads: theirs, and Add lead for a call or a walk-in, as its Deals and Events have. */
export function ContactLeads({ customerId, leads }: { customerId: string; leads: Lead[] }) {
  return (
    <div class="flex flex-col gap-3">
      <LeadList leads={leads} empty="No leads." />
      <AddToggle label="Add lead">
        {/* One column: this sits in the narrow side of a contact's page. */}
        <form method="post" action={`/customers/${customerId}/leads`} class="grid gap-3">
          <Field label="What they need">
            <input name="title" required maxlength={200} placeholder="New furnace" class={controlClass} />
          </Field>
          <Field label="Source">
            <select name="source" class={controlClass}>
              {MANUAL_SOURCES.map((s) => <option value={s}>{SOURCE_LABELS[s]}</option>)}
            </select>
          </Field>
          <Field label="Notes">
            <textarea name="notes" rows={2} maxlength={10000} class={controlClass}></textarea>
          </Field>
          <div>
            <button class={buttonClass}>Add lead</button>
          </div>
        </form>
      </AddToggle>
    </div>
  );
}

/** A contact's or a deal's leads, as a section's list: each opens its lead. */
export function LeadList({ leads, empty }: { leads: Lead[]; empty?: Child }) {
  if (!leads.length) return <p class="text-ink-3">{empty ?? "No leads."}</p>;
  return (
    <ul class="flex flex-col gap-3">
      {leads.map((l) => (
        <li class="flex flex-col gap-0.5">
          <span class="flex flex-wrap items-center gap-2">
            <a href={`/leads/${l.id}`} class="font-medium">{sourceText(l)}</a>
            <StatusBadge value={l.status} options={LEAD_TONES} />
          </span>
          <span class="text-label text-ink-3"><When at={l.created_at} timeZone={timeZone} day /></span>
          {l.said ? <span class="line-clamp-2 text-ink-2">{l.said}</span> : null}
        </li>
      ))}
    </ul>
  );
}

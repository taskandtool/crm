// One customer, laid out as every CRM lays out a record: what happens next
// (tasks), one Activity timeline (notes and calls, and everything they
// sent, paid and were quoted, newest first) with a small box to log
// a note on top, and their events; beside it, Details (their details as
// values, Edit for the form), their deals, quotes and invoices, possible
// duplicates, Merge and Archive. Empty sections are left out. Plain forms
// throughout: every change is a POST answered with a 303 back here.
import type { Child } from "hono/jsx";
import { JsonData, Section } from "../admin/detail";
import { Flash } from "../admin/flash";
import { When } from "../admin/list";
import { StatusBadge } from "../admin/status";
import { cfg, dealsCfg, eventsCfg, invoicesCfg, ownerLabel, vocab } from "../config";
import { dealChoices, type Deal } from "../crm/deals";
import type { Task } from "../crm/tasks";
import { CustomerDeals } from "./deals";
import { TasksSection } from "./tasks";
import { listUrl } from "../admin/query";
import type { Customer } from "../crm/customers";
import type { HistoryItem } from "../crm/history";
import { NoteForm } from "../customers/note-form";
import { NOTE_LABELS, type Note } from "../customers/notes";
import type { Stage } from "../crm/stages";
import type { Event } from "../crm/events";
import { missingSentence, type Present } from "../crm/tables";
import { formatMoney } from "../payments/money";
import { firstText } from "../crm/leads";
import type { Lead } from "../crm/leads";
import { ContactLeads } from "./leads";
import { Layout } from "./layout";
import { ArchivedNote, buttonClass, controlClass, menuItemClass, MoreMenu, CustomInput, Field, MESSAGES, primaryClass, ReadThenEdit, RecordLine, SaveOnChange, shownField, stageOptions, telHref, timeZone } from "./ui";
import { CustomerEvents, type Choices } from "./events";
import { CustomerMoney, type Owed } from "./money";
import type { Quote } from "../invoices/quotes";
import type { Invoice } from "../invoices/invoices";
import type { Card } from "../invoices/cards";
import type { Recurring } from "../invoices/recurring";
import { ownerSuggestions, personName } from "../crm/people";

/** How many Activity entries show before "Show older". */
const RECENT = 10;

export function CustomerPage(p: {
  user: string;
  customer: Customer;
  /** Their enquiries, open first (crm/leads.ts contactLeads). */
  leads: Lead[];
  stages: Stage[];
  notes: Note[];
  events: Event[];
  /** What a new event chooses from. */
  choices: Choices;
  history: HistoryItem[];
  present: Present;
  owners: string[];
  deals: Deal[];
  dealStages: Stage[];
  tasks: { open: Task[]; done: Task[] };
  today: string;
  /** Quotes and invoices, when they are on; null when off. */
  money: { quotes: Quote[]; invoices: Invoice[]; owed: Owed[]; recurring: Recurring[]; cards: Card[] } | null;
  /** Other records that may be the same person: same name, or same phone. */
  duplicates: Customer[];
  flash: { code?: string | null; n?: string | null };
  /** Their texts and calls on the business number (the phone skill's ContactTexts), once there is one. */
  texts?: Child;
  /** Their thread in Messages, where Text opens: once the business number can text and they have a phone. */
  textHref?: string | null;
}) {
  const c = p.customer;
  const self = `/customers/${c.id}`;
  // A status another app wrote, or one archived since, still shows and stays selectable.
  const stages = p.stages.some((s) => s.key === c.stage) ? p.stages : [...p.stages, { key: c.stage, label: c.stage, position: 999, kind: "open" as const, archived: true }];
  const missing = missingSentence(p.present);
  const money = p.money && (p.money.quotes.length || p.money.invoices.length || p.money.recurring.length || p.money.cards.length) ? p.money : null;
  return (
    <Layout
      title={c.name}
      user={p.user}
      section="customers"
      back={{ href: "/customers", label: vocab.many }}
      sub={<div class="flex flex-wrap items-center gap-x-2 gap-y-1"><StatusBadge value={c.stage} options={stageOptions(stages)} /><Reach c={c} /></div>}
      // Actions only; the status is a value, shown under the name and changed in Details, as HubSpot's About card and Pipedrive's Summary hold it.
      // As HubSpot's and Jobber's: the ways to reach them, then everything else under More, Archive last.
      // No primary: a person has no one next step; each section adds its own.
      actions={
        <>
          {c.phone ? <a href={telHref(c.phone)} class={buttonClass}>Call</a> : null}
          {p.textHref ? <a href={p.textHref} class={buttonClass}>Text</a> : null}
          {c.email ? <a href={`mailto:${c.email}`} class={buttonClass} title={c.email}>Email</a> : null}
          <MoreMenu items={[
            invoicesCfg ? <a href={listUrl("/invoices/quotes/new", { email: c.email, name: c.name, phone: c.phone, address: c.address })} class={menuItemClass}>New {invoicesCfg.word.toLowerCase()}</a> : null,
            <a href={`${self}/merge`} class={menuItemClass}>Merge</a>,
            c.archived_at ? null : (
              <form method="post" action={`${self}/archive`}>
                <input type="hidden" name="archived" value="1" />
                <button class={menuItemClass} title="Takes them out of the lists. Nothing is deleted.">Archive</button>
              </form>
            ),
          ]} />
        </>
      }
    >
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      {c.archived_at ? (
        <ArchivedNote action={`${self}/archive`} fields={{ archived: "0" }}>Archived <When at={c.archived_at} timeZone={timeZone} />. Still here, left out of the lists.</ArchivedNote>
      ) : null}
      <div class="grid gap-4 md:grid-cols-3">
        <div class="flex min-w-0 flex-col gap-4 md:col-span-2">
          <Section title="Tasks" count={p.tasks.open.length}>
            <TasksSection customerId={c.id} open={p.tasks.open} done={p.tasks.done}
              deals={dealChoices(p.deals)}
              owners={p.owners} user={p.user} today={p.today} returnTo={self} />
          </Section>
          {/* What is coming (tasks, then events) before the activity and its history, as Pipedrive's Focus comes before History. */}
          {eventsCfg ? (
            <Section title={eventsCfg.many} count={p.events.length}>
              <CustomerEvents c={c} events={p.events} choices={p.choices} deals={dealChoices(p.deals)} />
            </Section>
          ) : null}
          <Section title="Activity">
            <Activity c={c} notes={p.notes} history={p.history} missing={missing} />
          </Section>
        </div>
        <div class="flex min-w-0 flex-col gap-4">
          {p.texts}
          <Section title="Details">
            <div class="mb-3"><SaveOnChange action={`${self}/stage`} current={c.stage} options={stageOptions(stages)} label="Status" returnTo={self} /></div>
            <Details c={c} owners={p.owners} />
          </Section>
          <Section title="Leads" count={p.leads.length}>
            <ContactLeads customerId={c.id} leads={p.leads} />
          </Section>
          <Section title={dealsCfg.many} count={p.deals.filter((d) => !d.closed_at).length}>
            <CustomerDeals c={c} deals={p.deals} stages={p.dealStages} />
          </Section>
          {money ? <CustomerMoney c={c} {...money} /> : null}
          {p.duplicates.length ? (
            <Section title="Possible duplicates">
              <ul class="flex flex-col gap-2">
                {p.duplicates.map((d) => (
                  <li class="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span class="min-w-0 break-words">
                      {d.name}
                      <span class="block text-label text-ink-3">{[d.email, d.phone].filter(Boolean).join(" · ")}</span>
                    </span>
                    <a href={`${self}/merge?other=${d.id}`} class="text-label">Merge</a>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      </div>
      <RecordLine added={c.created_at} addedBy={c.created_by} changed={c.updated_at} changedBy={c.updated_by} />
    </Layout>
  );
}

/** How to reach them, under their name: company, phone, email. */
function Reach({ c }: { c: Customer }) {
  const parts = [
    c.company ? <span>{c.company}</span> : null,
    c.phone ? <a href={telHref(c.phone)} class="whitespace-nowrap text-ink-2">{c.phone}</a> : null,
    c.email ? <a href={`mailto:${c.email}`} class="break-all text-ink-2">{c.email}</a> : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <p class="flex flex-wrap gap-x-2">{parts.map((x, i) => <>{i ? <span aria-hidden="true">·</span> : null}{x}</>)}</p>;
}

/** Their details as values, then Edit for the form. */
function Details({ c, owners }: { c: Customer; owners: string[] }) {
  const custom = cfg.fields.map((f) => ({ label: f.label, value: shownField(f, c.fields?.[f.key]) || null }));
  return (
    <ReadThenEdit
      fields={[
          // Company, phone and email are under their name, at the top.
          ...(c.other_emails?.length ? [{ label: "Also goes by", value: c.other_emails.join(", ") }] : []),
          { label: "Address", value: c.address },
          { label: ownerLabel, value: personName(c.owner) },
          { label: "Source", value: c.source },
          { label: "Tags", value: c.tags.length ? c.tags.join(", ") : null },
          ...custom,
          { label: "Background", value: c.notes ? <span class="whitespace-pre-wrap">{c.notes}</span> : null },
          { label: "Last contact", value: c.last_contact_at ? <When at={c.last_contact_at} timeZone={timeZone} /> : null },
      ]}
    >
      <DetailsForm c={c} owners={owners} />
    </ReadThenEdit>
  );
}

function DetailsForm({ c, owners }: { c: Customer; owners: string[] }) {
  return (
    <form method="post" action={`/customers/${c.id}`} class="grid gap-3">
      <Field label="Name">
        <input name="name" value={c.name} required maxlength={200} class={controlClass} />
      </Field>
      <Field label="Email">
        <input name="email" type="email" value={c.email ?? ""} maxlength={254} class={controlClass} />
      </Field>
      <Field label="Phone">
        <input name="phone" type="tel" value={c.phone ?? ""} maxlength={40} class={controlClass} />
      </Field>
      <Field label="Company">
        <input name="company" value={c.company ?? ""} maxlength={200} class={controlClass} />
      </Field>
      <Field label="Address">
        <input name="address" value={c.address ?? ""} maxlength={500} autocomplete="off" class={controlClass} />
      </Field>
      <Field label={ownerLabel} hint="The team member responsible.">
        <input name="owner" list="owners" value={personName(c.owner)} maxlength={200} class={controlClass} />
        <datalist id="owners">
          {ownerSuggestions(owners).map((o) => (
            <option value={o} />
          ))}
        </datalist>
      </Field>
      <Field label="Source">
        <input name="source" list="sources" value={c.source ?? ""} maxlength={100} class={controlClass} />
        <datalist id="sources">
          {cfg.sources.map((s) => (
            <option value={s} />
          ))}
        </datalist>
      </Field>
      <Field label="Tags" hint="Separate tags with commas.">
        <input name="tags" value={c.tags.join(", ")} maxlength={1000} class={controlClass} />
      </Field>
      {cfg.fields.map((f) => (
        <CustomInput f={f} value={c.fields?.[f.key]} />
      ))}
      <Field label="Background">
        <textarea name="notes" rows={3} maxlength={10000} class={controlClass}>
          {c.notes ?? ""}
        </textarea>
      </Field>
      <div>
        <button class={primaryClass}>Save</button>
      </div>
    </form>
  );
}

type Entry = { at: Date; note?: Note; item?: HistoryItem };

/**
 * One timeline: what the team logged (notes, calls, emails, meetings,
 * texts, tasks done) and what the person did across the project
 * (submissions, payments, quotes and invoices sent; their events have their own section), newest
 * first; the latest RECENT, then the rest behind "Show older".
 */
function Activity({ c, notes, history, missing }: { c: Customer; notes: Note[]; history: HistoryItem[]; missing: string | null }) {
  const entries: Entry[] = [
    ...notes.map((n) => ({ at: new Date(n.happened_at), note: n })),
    ...history.map((i) => ({ at: new Date(i.at), item: i })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  const row = (e: Entry) => (e.note ? <NoteEntry n={e.note} /> : <HistoryEntry i={e.item!} />);
  return (
    <div class="flex flex-col gap-4">
      <NoteForm action={`/customers/${c.id}/notes`} />
      {missing && (c.email || c.phone) ? <p class="text-label text-ink-3">{missing}</p> : null}
      {entries.length ? (
        <>
          <Months entries={entries.slice(0, RECENT)} row={row} />
          {entries.length > RECENT ? (
            <details>
              <summary class="cursor-pointer text-label text-ink-2">Show {entries.length - RECENT} older</summary>
              <div class="mt-3"><Months entries={entries.slice(RECENT)} row={row} /></div>
            </details>
          ) : null}
        </>
      ) : (
        <p class="text-ink-3">No activity yet.</p>
      )}
    </div>
  );
}

/** "October", or "August 2025" outside this year: the month an entry happened in, in the business's zone. */
function monthOf(at: Date): string {
  const year = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(d);
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "long", year: year(at) === year(new Date()) ? undefined : "numeric" }).format(at);
}

/** The timeline under month headings, as HubSpot's activity is: newest month first. */
function Months({ entries, row }: { entries: Entry[]; row: (e: Entry) => Child }) {
  const months: [string, Entry[]][] = [];
  for (const e of entries) {
    const m = monthOf(e.at);
    const last = months[months.length - 1];
    if (last && last[0] === m) last[1].push(e);
    else months.push([m, [e]]);
  }
  return (
    <div class="flex flex-col gap-4">
      {months.map(([m, list]) => (
        <section aria-label={m}>
          <h3 class="mb-2 text-label font-semibold text-ink-3">{m}</h3>
          <ol class="flex flex-col gap-3">{list.map((e) => <li class="border-l-2 border-line pl-3">{row(e)}</li>)}</ol>
        </section>
      ))}
    </div>
  );
}

function NoteEntry({ n }: { n: Note }) {
  return (
    <>
      <p class="text-label text-ink-3">
        <span class="font-semibold text-ink-2">{NOTE_LABELS[n.kind] ?? n.kind}</span> · <When at={n.happened_at} timeZone={timeZone} />
        {n.author ? ` · ${n.author}` : ""}
      </p>
      <p class="whitespace-pre-wrap break-words">{n.body}</p>
    </>
  );
}

function HistoryEntry({ i }: { i: HistoryItem }) {
  const kindName =
    i.kind === "submission" ? i.form_title || i.form_key : i.kind === "payment" ? "Payment" : i.kind === "quote" ? `Quote ${i.number}` : i.number ? `Invoice ${i.number}` : "Invoice";
  return (
    <>
      <p class="text-label text-ink-3">
        <span class="font-semibold text-ink-2">{kindName}</span> · <When at={i.at} timeZone={timeZone} /> · {i.status.replace(/_/g, " ")}
      </p>
      {i.kind === "submission" ? (
        <>
          {firstText(i.data) ? <p class="line-clamp-3 break-words">{firstText(i.data)}</p> : null}
          <details class="mt-1">
            <summary class="cursor-pointer text-label text-ink-2">Everything they sent</summary>
            <div class="mt-2">
              <JsonData data={i.answers ?? i.data} />
            </div>
          </details>
        </>
      ) : i.kind === "quote" || i.kind === "invoice" ? (
        <p>
          <a href={i.kind === "quote" ? `/invoices/quotes/${i.id}` : `/invoices/${i.id}`}>{formatMoney(i.total_cents, i.currency)}</a>
        </p>
      ) : (
        <p>
          {formatMoney(i.amount_cents, i.currency)}
          {i.description ? `, ${i.description}` : ""}
          {i.livemode === false ? " (test mode)" : ""}
        </p>
      )}
    </>
  );
}

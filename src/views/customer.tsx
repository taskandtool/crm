// One customer, laid out as every CRM lays out a record: what happens next
// (follow-ups), one Activity timeline (notes and calls, and everything they
// sent, booked, paid and were quoted, newest first) with a small box to log
// a note on top, and their visits; beside it, About (their details as
// values, Edit for the form), their deals, quotes and invoices, possible
// duplicates, Merge and Archive. Empty sections are left out. Plain forms
// throughout: every change is a POST answered with a 303 back here.
import { FieldList, JsonData, Section, type Field as Shown } from "../admin/detail";
import { Flash } from "../admin/flash";
import { When } from "../admin/list";
import { cfg, dealsCfg, invoicesCfg, ownerLabel, showBooking, visitsCfg, vocab } from "../config";
import type { Deal } from "../crm/deals";
import { fieldText } from "../crm/fields";
import type { FollowUp } from "../crm/follow-ups";
import { CustomerDeals } from "./deals";
import { FollowUpsSection } from "./follow-ups";
import { listUrl } from "../admin/query";
import type { Customer } from "../crm/customers";
import type { HistoryItem } from "../crm/history";
import { NOTE_KINDS, NOTE_LABELS, type Note } from "../crm/notes";
import type { Stage } from "../crm/stages";
import type { Visit } from "../crm/visits";
import { missingSentence, type Present } from "../crm/tables";
import { money, nowIn } from "../crm/text";
import { whereText, type Booking } from "../booking/book";
import { firstText } from "./inbox";
import { Layout } from "./layout";
import { buttonClass, controlClass, CustomInput, Field, linkButtonClass, MESSAGES, primaryClass, SaveOnChange, stageOptions, timeZone, Who } from "./ui";
import { CustomerVisits } from "./visits";
import { CustomerMoney, type Owed } from "./money";
import type { Quote } from "../invoices/quotes";
import type { Invoice } from "../invoices/invoices";

/** How many Activity entries show before "Show older". */
const RECENT = 10;

export function CustomerPage(p: {
  user: string;
  customer: Customer;
  stages: Stage[];
  notes: Note[];
  visits: Visit[];
  history: HistoryItem[];
  present: Present;
  owners: string[];
  deals: Deal[];
  dealStages: Stage[];
  followUps: { open: FollowUp[]; done: FollowUp[] };
  today: string;
  /** Quotes and invoices, when they are on; null when off. */
  money: { quotes: Quote[]; invoices: Invoice[]; owed: Owed[] } | null;
  /** Other records that may be the same person: same name, or same phone. */
  duplicates: Customer[];
  flash: { code?: string | null; n?: string | null };
}) {
  const c = p.customer;
  const self = `/customers/${c.id}`;
  // A status another app wrote, or one archived since, still shows and stays selectable.
  const stages = p.stages.some((s) => s.key === c.stage) ? p.stages : [...p.stages, { key: c.stage, label: c.stage, position: 999, kind: "open" as const, archived: true }];
  const missing = missingSentence(p.present, { submissions: true, bookings: true, payments: true });
  const money = p.money && (p.money.quotes.length || p.money.invoices.length) ? p.money : null;
  return (
    <Layout title={c.name} user={p.user} section="customers">
      <p class="mb-3 text-label">
        <a href="/customers">All {vocab.many.toLowerCase()}</a>
      </p>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <SaveOnChange action={`${self}/stage`} current={c.stage} options={stageOptions(stages)} label="Status" returnTo={self} />
        {c.phone ? <a href={`tel:${c.phone.replace(/[^0-9+]/g, "")}`} class={linkButtonClass}>Call</a> : null}
        {c.email ? <a href={`mailto:${c.email}`} class={linkButtonClass} title={c.email}>Email</a> : null}
        {showBooking ? (
          <a href={listUrl("/bookings/new", { name: c.name, email: c.email, phone: c.phone, address: c.address })} class={linkButtonClass}>Book a time</a>
        ) : null}
        {invoicesCfg ? <a href={listUrl("/invoices/quotes/new", { email: c.email, name: c.name, phone: c.phone, address: c.address })} class={linkButtonClass}>New quote</a> : null}
      </div>
      {c.archived_at ? (
        <p role="status" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2">
          Archived <When at={c.archived_at} timeZone={timeZone} />. Still here, left out of the lists.
        </p>
      ) : null}
      <div class="grid gap-4 md:grid-cols-3">
        <div class="flex min-w-0 flex-col gap-4 md:col-span-2">
          <Section title="Follow-ups">
            <FollowUpsSection customerId={c.id} open={p.followUps.open} done={p.followUps.done}
              deals={p.deals.filter((d) => !d.closed_at).map((d) => ({ id: d.id, title: d.title }))}
              owners={p.owners} user={p.user} today={p.today} returnTo={self} />
          </Section>
          <Section title="Activity">
            <Activity c={c} notes={p.notes} history={p.history} missing={missing} />
          </Section>
          {visitsCfg ? (
            <Section title={visitsCfg.many}>
              <CustomerVisits c={c} visits={p.visits} owners={p.owners} />
            </Section>
          ) : null}
        </div>
        <div class="flex min-w-0 flex-col gap-4">
          <Section title="About">
            <About c={c} owners={p.owners} />
          </Section>
          <Section title={dealsCfg.many}>
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
          <div class="flex flex-wrap gap-2">
            <a href={`${self}/merge`} class={linkButtonClass}>Merge with another record</a>
            <form method="post" action={`${self}/archive`}>
              <input type="hidden" name="archived" value={c.archived_at ? "0" : "1"} />
              <button class={buttonClass} title={c.archived_at ? "Brings them back into the lists." : "Takes them out of the lists. Nothing is deleted."}>
                {c.archived_at ? "Unarchive" : "Archive"}
              </button>
            </form>
          </div>
        </div>
      </div>
    </Layout>
  );
}

/** Their details as values, then Edit for the form. */
function About({ c, owners }: { c: Customer; owners: string[] }) {
  const custom = cfg.fields.map((f) => ({ label: f.label, value: fieldText(c.fields?.[f.key]) || null }));
  // Only what is filled shows; Edit adds the rest.
  const filled = (f: Shown) => f.value !== null && f.value !== undefined && f.value !== "";
  return (
    <div class="flex flex-col gap-3">
      <FieldList
        fields={([
          { label: "Email", value: c.email ? <a href={`mailto:${c.email}`} class="break-all">{c.email}</a> : null },
          ...(c.other_emails?.length ? [{ label: "Also goes by", value: c.other_emails.join(", ") }] : []),
          { label: "Phone", value: c.phone ? <a href={`tel:${c.phone.replace(/[^0-9+]/g, "")}`}>{c.phone}</a> : null },
          { label: "Company", value: c.company },
          { label: "Address", value: c.address },
          { label: ownerLabel, value: c.owner },
          { label: "Source", value: c.source },
          { label: "Tags", value: c.tags.length ? c.tags.join(", ") : null },
          ...custom,
          { label: "Background", value: c.notes ? <span class="whitespace-pre-wrap">{c.notes}</span> : null },
          { label: "Last contact", value: c.last_contact_at ? <When at={c.last_contact_at} timeZone={timeZone} /> : null },
          { label: "Added", value: <Who at={c.created_at} by={c.created_by} /> },
        ] as Shown[]).filter(filled)}
      />
      <details>
        <summary class={buttonClass + " inline-block cursor-pointer list-none"}>Edit</summary>
        <div class="mt-3">
          <Details c={c} owners={owners} />
        </div>
      </details>
    </div>
  );
}

function Details({ c, owners }: { c: Customer; owners: string[] }) {
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
        <input name="owner" list="owners" value={c.owner ?? ""} maxlength={200} class={controlClass} />
        <datalist id="owners">
          {owners.map((o) => (
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
 * texts, follow-ups done) and what the person did across the project
 * (submissions, bookings, payments, quotes and invoices sent), newest
 * first; the latest RECENT, then the rest behind "Show older".
 */
function Activity({ c, notes, history, missing }: { c: Customer; notes: Note[]; history: HistoryItem[]; missing: string | null }) {
  const entries: Entry[] = [
    ...notes.map((n) => ({ at: new Date(n.happened_at), note: n })),
    ...history.map((i) => ({ at: new Date(i.at), item: i })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  const row = (e: Entry) => (e.note ? <NoteEntry n={e.note} /> : <HistoryEntry i={e.item!} customerId={c.id} />);
  return (
    <div class="flex flex-col gap-4">
      <form method="post" action={`/customers/${c.id}/notes`} aria-label="Log activity" class="flex flex-col gap-2">
        <textarea name="body" rows={2} required maxlength={10000} placeholder="Add a note, or log a call" aria-label="Note" class={controlClass}></textarea>
        <div class="flex flex-wrap items-center gap-2">
          <select name="kind" aria-label="Type" class={controlClass}>
            {NOTE_KINDS.map((k) => (
              <option value={k}>{NOTE_LABELS[k]}</option>
            ))}
          </select>
          <input name="at" type="datetime-local" value={nowIn(timeZone)} aria-label={`When, in ${timeZone}`} class={controlClass} />
          <button class={primaryClass}>Save</button>
        </div>
      </form>
      {missing && (c.email || c.phone) ? <p class="text-label text-ink-3">{missing}</p> : null}
      {entries.length ? (
        <>
          <ol class="flex flex-col gap-3">{entries.slice(0, RECENT).map((e) => <li class="border-l-2 border-line pl-3">{row(e)}</li>)}</ol>
          {entries.length > RECENT ? (
            <details>
              <summary class="cursor-pointer text-label text-ink-2">Show {entries.length - RECENT} older</summary>
              <ol class="mt-3 flex flex-col gap-3">{entries.slice(RECENT).map((e) => <li class="border-l-2 border-line pl-3">{row(e)}</li>)}</ol>
            </details>
          ) : null}
        </>
      ) : (
        <p class="text-ink-3">No activity yet.</p>
      )}
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

function BookingItem({ i, customerId }: { i: Extract<HistoryItem, { kind: "booking" }>; customerId: string }) {
  return (
    <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
      <div class="min-w-0">
        <p>
          {i.type_name ? `${i.type_name}, ` : ""}
          <When at={i.starts_at} timeZone={timeZone} />
          {i.resource_name ? ` with ${i.resource_name}` : ""}
        </p>
        {i.location ? <p class="break-words text-label text-ink-2">{whereText({ location_kind: i.location_kind as Booking["location_kind"], location: i.location }, { link: true })}</p> : null}
        <p class="text-label"><a href={`/bookings/${i.id}`}>The booking</a></p>
      </div>
      {visitsCfg ? (
        i.visit_id ? (
          <a href={`/visits/${i.visit_id}`} class="text-label">The {visitsCfg.one.toLowerCase()}</a>
        ) : (
          <form method="post" action={`/bookings/${i.id}/job`}>
            <input type="hidden" name="customer" value={customerId} />
            <button class={buttonClass}>Create {visitsCfg.one.toLowerCase()}</button>
          </form>
        )
      ) : null}
    </div>
  );
}

function HistoryEntry({ i, customerId }: { i: HistoryItem; customerId: string }) {
  const kindName =
    i.kind === "submission" ? i.form_title || i.form_key : i.kind === "booking" ? "Booking" : i.kind === "payment" ? "Payment" : i.kind === "quote" ? `Quote ${i.number}` : i.number ? `Invoice ${i.number}` : "Invoice";
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
              <JsonData data={i.data} />
            </div>
          </details>
        </>
      ) : i.kind === "booking" ? (
        <BookingItem i={i} customerId={customerId} />
      ) : i.kind === "quote" || i.kind === "invoice" ? (
        <p>
          <a href={i.kind === "quote" ? `/invoices/quotes/${i.id}` : `/invoices/${i.id}`}>{money(i.total_cents, i.currency)}</a>
        </p>
      ) : (
        <p>
          {money(i.amount_cents, i.currency)}
          {i.description ? `, ${i.description}` : ""}
          {i.livemode === false ? " (test mode)" : ""}
        </p>
      )}
    </>
  );
}

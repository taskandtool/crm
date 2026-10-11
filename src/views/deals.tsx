// Deals: the board (a column per active stage, each with its count and what
// its deals are worth; drag a card, or use its select), one deal's page, and
// the deals section of a customer's page. Plain forms; a card's select posts
// through htmx and the server answers with the whole board.
import { FieldList, Section } from "../admin/detail";
import { Flash } from "../admin/flash";
import { When } from "../admin/list";
import { listUrl } from "../admin/query";
import { StatusBadge, StatusForm } from "../admin/status";
import { dealsCfg, invoicesCfg, ownerLabel, visitsCfg, vocab } from "../config";
import type { Customer } from "../crm/customers";
import type { Deal } from "../crm/deals";
import { dueOf, type FollowUp } from "../crm/follow-ups";
import { KIND_LABELS, type Stage } from "../crm/stages";
import { cash } from "../crm/text";
import { amountText, type Visit } from "../crm/visits";
import { QUOTE_OPTIONS, todayIn } from "../invoices/admin";
import { shownStatus, type Quote } from "../invoices/quotes";
import { formatMoney } from "../payments/money";
import { FollowUpsSection } from "./follow-ups";
import { Layout } from "./layout";
import { buttonClass, controlClass, dueDayText, DueMark, Field, linkButtonClass, MESSAGES, PersonFields, primaryClass, primaryLinkClass, RecordLine, SaveOnChange, stageOptions, timeZone } from "./ui";

/** How many cards a column shows; how many days won and lost ones stay on the board. */
export const PER_COLUMN = 100;
export const CLOSED_DAYS = 30;

const one = dealsCfg.one.toLowerCase();
const many = dealsCfg.many.toLowerCase();
const worth = (d: Deal) => (d.shown_cents === null ? null : cash(d.shown_cents, d.currency ?? dealsCfg.currency));

export type BoardData = {
  stages: Stage[];
  cards: Deal[];
  totals: Record<string, { count: number; cents: string; other: number }>;
  next: Map<string, { due_on: string; due_time: string | null }>;
  today: string;
};

export function DealsPage(p: { user: string; data: BoardData; flash: { code?: string | null; n?: string | null } }) {
  return (
    <Layout title={dealsCfg.many} user={p.user} section="deals" drag wide
      actions={<a href="/deals/new" class={primaryLinkClass}>New {one}</a>}>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <Board data={p.data} />
    </Layout>
  );
}

/** A new deal from the board: the person (matched by email or phone, or added) and what is being won. */
export function NewDealPage(p: { user: string; stages: Stage[]; flash: { code?: string | null; n?: string | null } }) {
  return (
    <Layout title={`New ${one}`} user={p.user} section="deals" back={{ href: "/deals", label: dealsCfg.many }}>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <form method="post" action="/deals" class="grid max-w-3xl gap-3 rounded-card border border-line bg-surface p-4 sm:grid-cols-3">
        <PersonFields />
        <DealInputs stages={p.stages.filter((s) => s.kind === "open")} />
        <div class="sm:col-span-3">
          <button class={primaryClass}>Add {one}</button>
          <span class="ml-3 text-label text-ink-3">Someone already here by email or phone gets it; anyone else is added.</span>
        </div>
      </form>
    </Layout>
  );
}

/** What a new deal needs: what it is, its value, its stage. On the board and on a customer's page. */
function DealInputs({ stages }: { stages: Stage[] }) {
  return (
    <>
      <Field label={`${dealsCfg.one} name`}>
        <input name="title" required maxlength={200} placeholder="New furnace" class={controlClass} />
      </Field>
      <Field label={`Value (${dealsCfg.currency})`} hint="Blank uses the quote's total.">
        <input name="value" inputmode="decimal" maxlength={20} class={controlClass} />
      </Field>
      <Field label="Stage">
        <select name="stage" class={controlClass}>
          {stages.map((s) => <option value={s.key}>{s.label}</option>)}
        </select>
      </Field>
    </>
  );
}

export function Board({ data }: { data: BoardData }) {
  const { stages, cards, totals } = data;
  const known = new Set(stages.map((s) => s.key));
  // Deals in a stage that is archived or unknown get a column of their own at the start, so none disappears.
  const strays = cards.filter((d) => !known.has(d.stage));
  const options = stageOptions(stages);
  const column = (key: string, label: string, kind: Stage["kind"] | null, list: Deal[]) => {
    const t = key ? totals[key] : { count: strays.length, cents: "0", other: 0 };
    const total = t && BigInt(t.cents) > 0n ? cash(t.cents, dealsCfg.currency) : null;
    return (
      <section data-stage={key} aria-label={`${label}, ${t?.count ?? 0}`} class="flex min-w-60 max-w-80 flex-1 basis-0 flex-col rounded-card bg-panel p-2">
        <h2 class="mb-2 px-1 text-label">
          <span class="flex items-baseline justify-between gap-2">
            <span class="font-semibold text-ink">{label}</span>
            <span class="text-ink-3">{t?.count ?? 0}</span>
          </span>
          {total || (kind && kind !== "open") ? (
            <span class="block text-ink-3">
              {total ?? ""}
              {total && t?.other ? ` and ${t.other} in other currencies` : ""}
              {kind && kind !== "open" ? `${total ? " · " : ""}${label.toLowerCase() === kind ? "Last" : `${KIND_LABELS[kind]}, last`} ${CLOSED_DAYS} days` : ""}
            </span>
          ) : null}
        </h2>
        <ul data-cards data-stage={key} class="flex flex-1 flex-col gap-2">
          {list.map((d) => <Card d={d} options={options} stray={!known.has(d.stage)} next={data.next.get(d.customer_id)} today={data.today} open={kind === "open"} />)}
        </ul>
        {t && t.count > list.length ? <p class="mt-2 px-1 text-label text-ink-3">and {t.count - list.length} more</p> : null}
      </section>
    );
  };
  return (
    <div id="pipeline">
      {!cards.length ? (
        <p class="mb-3 text-ink-2">
          No {many} yet. Add one here, from a {vocab.one.toLowerCase()}'s page, or from the Inbox.
        </p>
      ) : null}
      <div class="flex gap-3 overflow-x-auto pb-3">
        {strays.length ? column("", "Not in a stage", null, strays) : null}
        {stages.map((s) => column(s.key, s.label, s.kind, cards.filter((d) => d.stage === s.key)))}
      </div>
    </div>
  );
}

function Card({ d, options, stray, next, today, open }: { d: Deal; options: ReturnType<typeof stageOptions>; stray: boolean; next: { due_on: string; due_time: string | null } | undefined; today: string; open: boolean }) {
  const value = worth(d);
  return (
    <li data-deal-id={d.id} class="cursor-pointer rounded-card border border-line bg-surface px-3 py-2 shadow-card hover:border-line-strong">
      <a href={`/deals/${d.id}`} class="font-semibold no-underline">
        {d.title}
      </a>
      <p class="truncate text-label text-ink-2">
        {d.customer_name}
        {value ? ` · ${value}` : ""}
      </p>
      <p class="flex flex-wrap gap-x-2 text-label text-ink-3">
        {open || stray ? <NextMark next={next} today={today} /> : d.closed_at ? <span>Closed <When at={d.closed_at} timeZone={timeZone} day /></span> : null}
        {d.owner ? <span class="truncate">{ownerLabel}: {d.owner}</span> : null}
      </p>
      {/* Dragging moves a card on a wide screen; the select is for a phone, and for a browser without JavaScript. */}
      <div class="mt-2 md:[.js_&]:hidden">
        <StatusForm
          action={`/deals/${d.id}/stage`}
          current={stray ? "" : d.stage}
          options={stray ? [{ value: "", label: "Choose a stage" }, ...options] : options}
          returnTo="/deals"
          label={`Stage of ${d.title}`}
          swap="#pipeline"
        />
      </div>
    </li>
  );
}

/** A card's next follow-up: Today and Overdue say what they are; a later day says it is the follow-up. */
function NextMark({ next, today }: { next: { due_on: string; due_time: string | null } | undefined; today: string }) {
  const later = !!next && dueOf(next, today) === "later";
  return later ? <span>Follow-up <DueMark next={next} today={today} /></span> : <DueMark next={next} today={today} />;
}

/** One deal: its stage, worth, follow-ups, details, quotes and jobs. */
export function DealPage(p: {
  user: string;
  deal: Deal;
  stages: Stage[];
  followUps: { open: FollowUp[]; done: FollowUp[] };
  openDeals: { id: string; title: string }[];
  quotes: Quote[] | null;
  jobs: Visit[];
  owners: string[];
  today: string;
  flash: { code?: string | null; n?: string | null };
}) {
  const d = p.deal;
  const self = `/deals/${d.id}`;
  const stage = p.stages.find((s) => s.key === d.stage);
  const stages = stage ? p.stages : [...p.stages, { key: d.stage, label: d.stage, position: 999, kind: "open" as const, archived: true }];
  const value = worth(d);
  // A won or lost deal shows what happened; nothing on it asks for a next step.
  const closed = !!stage && stage.kind !== "open";
  const who = { email: d.customer_email, name: d.customer_name, phone: d.customer_phone, deal: d.id, line: d.title };
  return (
    <Layout
      title={d.title}
      user={p.user}
      section="deals"
      back={{ href: "/deals", label: dealsCfg.many }}
      sub={<>For <a href={`/customers/${d.customer_id}`}>{d.customer_name}</a></>}
      actions={
        <>
          <SaveOnChange action={`${self}/stage`} current={d.stage} options={stageOptions(stages)} label="Stage" returnTo={self} />
          {invoicesCfg && d.customer_email ? <a href={listUrl("/invoices/quotes/new", who)} class={linkButtonClass}>New quote</a> : null}
        </>
      }
    >
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      {d.archived_at ? (
        <p role="status" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2">
          Archived <When at={d.archived_at} timeZone={timeZone} />. Off the board; nothing is deleted.
        </p>
      ) : null}
      <div class="grid gap-4 md:grid-cols-3">
        <div class="flex min-w-0 flex-col gap-4 md:col-span-2">
          {stage?.kind === "lost" ? (
            <Section title="Lost reason">
              <form method="post" action={`${self}/stage`} class="flex flex-wrap items-end gap-3">
                <input type="hidden" name="status" value={d.stage} />
                <input type="hidden" name="return" value={self} />
                <label class="flex min-w-48 flex-1 flex-col">
                  <input name="lost_reason" aria-label="Lost reason" list="lost-reasons" value={d.lost_reason ?? ""} maxlength={200} class={controlClass} />
                  <datalist id="lost-reasons">
                    {dealsCfg.lost_reasons.map((r) => <option value={r} />)}
                  </datalist>
                </label>
                <button class={buttonClass}>Save</button>
              </form>
            </Section>
          ) : null}
          {!closed || p.followUps.open.length ? (
            <Section title="Follow-ups">
              <FollowUpsSection customerId={d.customer_id} open={p.followUps.open} done={p.followUps.done} deals={p.openDeals} dealId={d.id}
                owners={p.owners} user={p.user} today={p.today} returnTo={self} prompt={!closed} />
            </Section>
          ) : null}
          {p.quotes && (p.quotes.length || !closed) ? (
            <Section title="Quotes">
              {p.quotes.length ? (
                <ul class="flex flex-col gap-2">
                  {p.quotes.map((q) => (
                    <li class="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <a href={`/invoices/quotes/${q.id}`}>Quote {q.number}</a>
                      <StatusBadge value={shownStatus(q, todayIn(timeZone))} options={QUOTE_OPTIONS} />
                      <span class="whitespace-nowrap">{formatMoney(q.total_cents, q.currency)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="text-ink-3">No quotes yet. {d.customer_email ? `Accepting a quote marks the ${one} won.` : `Add an email to ${d.customer_name} to send a quote.`}</p>
              )}
            </Section>
          ) : null}
          {visitsCfg && (p.jobs.length || stage?.kind === "won") ? (
            <Section title={visitsCfg.many}>
              {p.jobs.length ? (
                <ul class="flex flex-col gap-1">
                  {p.jobs.map((j) => <li><a href={`/visits/${j.id}`}>{j.title}</a></li>)}
                </ul>
              ) : (
                <form method="post" action={`${self}/job`}>
                  <button class={buttonClass}>Create {visitsCfg.one.toLowerCase()}</button>
                </form>
              )}
            </Section>
          ) : null}
        </div>
        <div class="flex flex-col gap-4">
          <Section title="About">
            <div class="flex flex-col gap-3">
              <FieldList
                fields={[
                  { label: "Value", value: value ? `${value}${d.from_quote ? " (from the quote)" : ""}` : "Not set" },
                  ...(d.expected_close ? [{ label: "Expected close", value: dueDayText(d.expected_close, p.today) }] : []),
                  ...(d.owner ? [{ label: ownerLabel, value: d.owner }] : []),
                  { label: "In this stage since", value: <When at={d.stage_changed_at} timeZone={timeZone} day /> },
                  ...(d.closed_at ? [{ label: "Closed", value: <When at={d.closed_at} timeZone={timeZone} day /> }] : []),
                  ...(d.notes ? [{ label: "Notes", value: <span class="whitespace-pre-wrap">{d.notes}</span> }] : []),
                ]}
              />
              <details>
                <summary class={buttonClass + " inline-block cursor-pointer list-none"}>Edit</summary>
                <div class="mt-3">
                  <DealEdit d={d} owners={p.owners} />
                </div>
              </details>
            </div>
          </Section>
        </div>
      </div>
      <RecordLine added={d.created_at} addedBy={d.created_by} changed={d.updated_at} changedBy={d.updated_by}>
        <form method="post" action={`${self}/archive`}>
          <input type="hidden" name="archived" value={d.archived_at ? "0" : "1"} />
          <button class="text-ink-2 underline" title={d.archived_at ? "Puts it back on the board." : "Takes it off the board. Nothing is deleted."}>
            {d.archived_at ? "Unarchive" : "Archive"}
          </button>
        </form>
      </RecordLine>
    </Layout>
  );
}

/** The deal's own fields, behind Edit on its page. */
function DealEdit({ d, owners }: { d: Deal; owners: string[] }) {
  return (
    <form method="post" action={`/deals/${d.id}`} class="grid gap-3">
      <Field label={`${dealsCfg.one} name`}>
        <input name="title" value={d.title} required maxlength={200} class={controlClass} />
      </Field>
      <Field label={`Value (${(d.currency ?? dealsCfg.currency).toUpperCase()})`} hint="Blank uses the quote's total.">
        <input name="value" inputmode="decimal" value={d.value_cents === null ? "" : amountText(d.value_cents, d.currency ?? dealsCfg.currency)} maxlength={20} class={controlClass} />
      </Field>
      <Field label="Expected close date">
        <input name="expected_close" type="date" value={d.expected_close ?? ""} class={controlClass} />
      </Field>
      <Field label={ownerLabel}>
        <input name="owner" list="owners" value={d.owner ?? ""} maxlength={200} class={controlClass} />
        <datalist id="owners">
          {owners.map((o) => <option value={o} />)}
        </datalist>
      </Field>
      <Field label="Notes">
        <textarea name="notes" rows={3} maxlength={10000} class={controlClass}>{d.notes ?? ""}</textarea>
      </Field>
      <div>
        <button class={primaryClass}>Save</button>
      </div>
    </form>
  );
}

/** A customer's deals: the open ones with their stage and worth, the closed ones folded away, and a new one. */
export function CustomerDeals({ c, deals, stages }: { c: Customer; deals: Deal[]; stages: Stage[] }) {
  const options = stageOptions(stages);
  const open = deals.filter((d) => !d.closed_at);
  const closed = deals.filter((d) => d.closed_at);
  const item = (d: Deal) => (
    <li class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <a href={`/deals/${d.id}`} class="font-semibold">{d.title}</a>
      <StatusBadge value={d.stage} options={options} />
      {worth(d) ? <span class="whitespace-nowrap">{worth(d)}</span> : null}
      {d.closed_at ? <span class="text-label text-ink-3">closed <When at={d.closed_at} timeZone={timeZone} day /></span> : null}
    </li>
  );
  return (
    <div class="flex flex-col gap-3">
      {open.length ? <ul class="flex flex-col gap-2">{open.map(item)}</ul> : <p class="text-ink-3">No open {many}.</p>}
      {closed.length ? (
        <details>
          <summary class="cursor-pointer text-label text-ink-2">{closed.length === 1 ? `1 closed ${one}` : `${closed.length} closed ${many}`}</summary>
          <ul class="mt-2 flex flex-col gap-2">{closed.map(item)}</ul>
        </details>
      ) : null}
      <details>
        <summary class="cursor-pointer text-label font-semibold text-ink-2">Add {one}</summary>
        <form method="post" action={`/customers/${c.id}/deals`} class="mt-3 grid gap-3 sm:grid-cols-3">
          <DealInputs stages={stages.filter((s) => s.kind === "open")} />
          <div class="sm:col-span-3">
            <button class={primaryClass}>Add {one}</button>
          </div>
        </form>
      </details>
    </div>
  );
}

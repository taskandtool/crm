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
import type { FollowUp } from "../crm/follow-ups";
import { KIND_LABELS, type Stage } from "../crm/stages";
import { money } from "../crm/text";
import { amountText, type Visit } from "../crm/visits";
import { QUOTE_OPTIONS, todayIn } from "../invoices/admin";
import { shownStatus, type Quote } from "../invoices/quotes";
import { formatMoney } from "../payments/money";
import { FollowUpsSection } from "./follow-ups";
import { Layout } from "./layout";
import { buttonClass, controlClass, DueMark, Field, linkButtonClass, MESSAGES, primaryClass, stageOptions, timeZone, Who } from "./ui";

/** How many cards a column shows; how many days won and lost ones stay on the board. */
export const PER_COLUMN = 100;
export const CLOSED_DAYS = 30;

const one = dealsCfg.one.toLowerCase();
const many = dealsCfg.many.toLowerCase();
const worth = (d: Deal) => (d.shown_cents === null ? null : money(d.shown_cents, d.currency ?? dealsCfg.currency));

export type BoardData = {
  stages: Stage[];
  cards: Deal[];
  totals: Record<string, { count: number; cents: string; other: number }>;
  next: Map<string, { due_on: string; due_time: string | null }>;
  today: string;
};

export function DealsPage(p: { user: string; data: BoardData; flash: { code?: string | null; n?: string | null } }) {
  const open = p.data.stages.filter((s) => s.kind === "open");
  return (
    <Layout title={dealsCfg.many} user={p.user} section="deals" drag wide>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <details class="mb-4 rounded-card border border-line bg-surface p-4">
        <summary class="cursor-pointer text-label font-semibold text-ink-2">New {one}</summary>
        <form method="post" action="/deals" class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={`${vocab.one}'s name`}>
            <input name="name" maxlength={200} autocomplete="off" class={controlClass} />
          </Field>
          <Field label="Email">
            <input name="email" type="email" maxlength={254} autocomplete="off" class={controlClass} />
          </Field>
          <Field label="Phone">
            <input name="phone" type="tel" maxlength={40} autocomplete="off" class={controlClass} />
          </Field>
          <DealInputs stages={open} />
          <div class="sm:col-span-2 lg:col-span-3">
            <button class={primaryClass}>Add {one}</button>
            <span class="ml-3 text-label text-ink-3">Someone already here by email or phone gets it; anyone else is added as a {vocab.one.toLowerCase()}.</span>
          </div>
        </form>
      </details>
      <p class="mb-3 text-label text-ink-3">
        Drag a card to another stage (on a phone, press and hold first), or choose its stage on the card. Won and lost ones stay here for {CLOSED_DAYS} days.
      </p>
      <Board data={p.data} />
    </Layout>
  );
}

/** What a new deal needs: what it is, its value, its stage. On the board and on a customer's page. */
function DealInputs({ stages }: { stages: Stage[] }) {
  return (
    <>
      <Field label={`What the ${one} is`}>
        <input name="title" required maxlength={200} placeholder="New furnace" class={controlClass} />
      </Field>
      <Field label={`Value (${dealsCfg.currency})`} hint="Blank until you know; a quote fills it.">
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
    const total = t && BigInt(t.cents) > 0n ? money(t.cents, dealsCfg.currency) : null;
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
          No {many} yet. Add one above, from a {vocab.one.toLowerCase()}'s page, or with Add as {one} on What came in.
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
        {open || stray ? <DueMark next={next} today={today} /> : d.closed_at ? <span>Closed <When at={d.closed_at} timeZone={timeZone} /></span> : null}
        {d.owner ? <span class="truncate">{ownerLabel}: {d.owner}</span> : null}
      </p>
      <div class="mt-2">
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
  const who = { email: d.customer_email, name: d.customer_name, phone: d.customer_phone, deal: d.id, line: d.title };
  return (
    <Layout title={d.title} user={p.user} section="deals">
      <p class="mb-3 text-label">
        <a href="/deals">All {many}</a>
      </p>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span class="flex items-center gap-2">
          <span class="text-label text-ink-2" aria-hidden="true">Stage</span>
          <StatusForm action={`${self}/stage`} current={d.stage} options={stageOptions(stages)} returnTo={self} label="Stage" />
        </span>
        <a href={`/customers/${d.customer_id}`} class={linkButtonClass}>{d.customer_name}</a>
        {invoicesCfg && d.customer_email ? <a href={listUrl("/invoices/quotes/new", who)} class={linkButtonClass}>New quote</a> : null}
      </div>
      {d.archived_at ? (
        <p role="status" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2">
          Archived <When at={d.archived_at} timeZone={timeZone} />. Off the board; nothing is deleted.
        </p>
      ) : null}
      <div class="grid gap-4 md:grid-cols-3">
        <div class="flex min-w-0 flex-col gap-4 md:col-span-2">
          {stage?.kind === "lost" ? (
            <Section title="Why it was lost">
              <form method="post" action={`${self}/stage`} class="flex flex-wrap items-end gap-3">
                <input type="hidden" name="status" value={d.stage} />
                <input type="hidden" name="return" value={self} />
                <Field label="Reason" class="min-w-48 flex-1">
                  <input name="lost_reason" list="lost-reasons" value={d.lost_reason ?? ""} maxlength={200} class={controlClass} />
                  <datalist id="lost-reasons">
                    {dealsCfg.lost_reasons.map((r) => <option value={r} />)}
                  </datalist>
                </Field>
                <button class={buttonClass}>Save</button>
              </form>
            </Section>
          ) : null}
          <Section title="Follow-ups">
            <FollowUpsSection customerId={d.customer_id} open={p.followUps.open} done={p.followUps.done} deals={p.openDeals} dealId={d.id}
              owners={p.owners} user={p.user} today={p.today} returnTo={self} />
          </Section>
          <Section title="Details">
            <form method="post" action={self} class="grid gap-3 sm:grid-cols-2">
              <Field label={`What the ${one} is`} class="sm:col-span-2">
                <input name="title" value={d.title} required maxlength={200} class={controlClass} />
              </Field>
              <Field label={`Value (${(d.currency ?? dealsCfg.currency).toUpperCase()})`} hint={d.from_quote ? "Blank: the latest quote's total stands in." : undefined}>
                <input name="value" inputmode="decimal" value={d.value_cents === null ? "" : amountText(d.value_cents, d.currency ?? dealsCfg.currency)} maxlength={20} class={controlClass} />
              </Field>
              <Field label="Expected to close">
                <input name="expected_close" type="date" value={d.expected_close ?? ""} class={controlClass} />
              </Field>
              <Field label={ownerLabel} hint="Who is working on it.">
                <input name="owner" list="owners" value={d.owner ?? ""} maxlength={200} class={controlClass} />
                <datalist id="owners">
                  {p.owners.map((o) => <option value={o} />)}
                </datalist>
              </Field>
              <Field label="Notes" class="sm:col-span-2">
                <textarea name="notes" rows={3} maxlength={10000} class={controlClass}>{d.notes ?? ""}</textarea>
              </Field>
              <div class="sm:col-span-2">
                <button class={primaryClass}>Save</button>
              </div>
            </form>
          </Section>
          {p.quotes ? (
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
                <p class="text-ink-3">No quote for this {one} yet. {d.customer_email ? "When one is accepted, the deal is won." : `Add an email to ${d.customer_name} to quote them.`}</p>
              )}
            </Section>
          ) : null}
          {visitsCfg ? (
            <Section title={visitsCfg.many}>
              {p.jobs.length ? (
                <ul class="flex flex-col gap-1">
                  {p.jobs.map((j) => <li><a href={`/visits/${j.id}`}>{j.title}</a></li>)}
                </ul>
              ) : stage?.kind === "won" ? (
                <form method="post" action={`${self}/job`}>
                  <button class={buttonClass}>Make it a {visitsCfg.one.toLowerCase()}</button>
                </form>
              ) : (
                <p class="text-ink-3">Once it is won, make it a {visitsCfg.one.toLowerCase()} here.</p>
              )}
            </Section>
          ) : null}
        </div>
        <div class="flex flex-col gap-4">
          <Section title="Record">
            <FieldList
              fields={[
                { label: "Worth", value: value ? `${value}${d.from_quote ? " (its quote)" : ""}` : "Not set" },
                { label: "In this stage since", value: <When at={d.stage_changed_at} timeZone={timeZone} /> },
                ...(d.closed_at ? [{ label: "Closed", value: <When at={d.closed_at} timeZone={timeZone} /> }] : []),
                { label: "Added", value: <Who at={d.created_at} by={d.created_by} /> },
                { label: "Changed", value: <Who at={d.updated_at} by={d.updated_by} /> },
              ]}
            />
          </Section>
          <Section title="Archive">
            <form method="post" action={`${self}/archive`} class="flex flex-col gap-2">
              <input type="hidden" name="archived" value={d.archived_at ? "0" : "1"} />
              <p class="text-label text-ink-3">{d.archived_at ? "Put it back on the board." : "Takes it off the board, for one added by mistake. Nothing is deleted."}</p>
              <button class={buttonClass + " self-start"}>{d.archived_at ? "Unarchive" : "Archive"}</button>
            </form>
          </Section>
        </div>
      </div>
    </Layout>
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
      {d.closed_at ? <span class="text-label text-ink-3">closed <When at={d.closed_at} timeZone={timeZone} /></span> : null}
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
        <summary class="cursor-pointer text-label font-semibold text-ink-2">New {one}</summary>
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

// Follow-ups: the list the team starts the day on (Due: overdue first, then
// today; Upcoming; Nothing planned), mine or everyone's, and the pieces the
// customer and deal pages share: one follow-up with Done and Move, and the
// form that adds one. Plain forms; every change is a POST answered with a
// 303 back to where it came from.
import type { Child } from "hono/jsx";
import { Flash } from "../admin/flash";
import { When } from "../admin/list";
import { listUrl } from "../admin/query";
import { dealsCfg, ownerLabel, vocab } from "../config";
import { addDays, FOLLOW_UP_KINDS, FOLLOW_UP_LABELS, UPCOMING_DAYS, type FollowUp, type FollowUpView, type Unplanned } from "../crm/follow-ups";
import { Layout } from "./layout";
import { buttonClass, controlClass, DueMark, Field, MESSAGES, primaryClass, timeText, timeZone } from "./ui";

export type FollowUpsProps = {
  user: string;
  view: FollowUpView;
  mine: boolean;
  today: string;
  rows: FollowUp[];
  unplanned: Unplanned[];
  /** More than the page shows. */
  more: boolean;
  counts: { overdue: number; today: number };
  flash: { code?: string | null; n?: string | null };
};

export function FollowUpsPage(p: FollowUpsProps) {
  const href = (view: FollowUpView, all = !p.mine) => listUrl("/follow-ups", { view: view === "due" ? null : view, who: all ? "all" : null });
  const self = href(p.view);
  const due = p.counts.overdue + p.counts.today;
  const tab = (view: FollowUpView, label: string) => (
    <a href={href(view)} aria-current={p.view === view ? "page" : undefined}
      class={"rounded-control px-2 py-1 no-underline " + (p.view === view ? "bg-panel font-semibold" : "text-ink-2 hover:bg-panel")}>
      {label}
    </a>
  );
  return (
    <Layout title="Follow-ups" user={p.user} section="follow-ups">
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3 text-label">
        <nav aria-label="Which follow-ups" class="flex flex-wrap gap-1">
          {tab("due", due ? `Due (${due})` : "Due")}
          {tab("upcoming", `Next ${UPCOMING_DAYS} days`)}
          {tab("none", "Nothing planned")}
        </nav>
        <nav aria-label="Whose" class="flex gap-1">
          <a href={href(p.view, false)} aria-current={p.mine ? "page" : undefined}
            class={"rounded-control px-2 py-1 no-underline " + (p.mine ? "bg-panel font-semibold" : "text-ink-2 hover:bg-panel")}>Mine</a>
          <a href={href(p.view, true)} aria-current={!p.mine ? "page" : undefined}
            class={"rounded-control px-2 py-1 no-underline " + (!p.mine ? "bg-panel font-semibold" : "text-ink-2 hover:bg-panel")}>Everyone</a>
        </nav>
      </div>
      {p.view === "none" ? (
        <>
          <p class="mb-3 max-w-2xl text-ink-2">
            {vocab.many} still in play (an open status or an open {dealsCfg.one.toLowerCase()}) with no follow-up and nothing booked. Quietest first.
          </p>
          {p.unplanned.length ? (
            <ol class="flex flex-col overflow-hidden rounded-card border border-line bg-surface">
              {p.unplanned.map((u) => <UnplannedRow u={u} today={p.today} returnTo={self} user={p.user} />)}
            </ol>
          ) : (
            <Empty>Everyone in play has something planned.</Empty>
          )}
        </>
      ) : p.rows.length ? (
        <ol class="flex flex-col overflow-hidden rounded-card border border-line bg-surface">
          {p.rows.map((f) => (
            <li class="border-b border-line px-4 py-3 last:border-b-0">
              <FollowUpItem f={f} today={p.today} returnTo={self} showCustomer showOwner={!p.mine} />
            </li>
          ))}
        </ol>
      ) : (
        <Empty>
          {p.view === "due" ? "Nothing due. " : `Nothing in the next ${UPCOMING_DAYS} days. `}
          <a href={href("none")}>See who has nothing planned</a>
        </Empty>
      )}
      {p.more ? <p class="mt-3 text-label text-ink-3">The first {p.view === "none" ? p.unplanned.length : p.rows.length}; tick some off to see the rest.</p> : null}
      {p.mine ? <p class="mt-4 text-label text-ink-3">Mine is what is set for you, {p.user}. Everyone shows the whole team's.</p> : null}
    </Layout>
  );
}

function Empty({ children }: { children: Child }) {
  return <div class="rounded-card border border-line bg-surface px-4 py-8 text-center text-ink-2">{children}</div>;
}

/** One follow-up: when, what, for whom, and Done and Move. */
export function FollowUpItem(p: { f: FollowUp; today: string; returnTo: string; showCustomer?: boolean; showOwner?: boolean }) {
  const { f, today } = p;
  const label = `${FOLLOW_UP_LABELS[f.kind]}: ${f.title}`;
  return (
    <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
      <div class="min-w-0 flex-1">
        <p class="flex flex-wrap items-center gap-x-2 text-label text-ink-3">
          <DueMark next={f} today={today} />
          {f.due_on < today && f.due_time ? <span>{timeText(f.due_time)}</span> : null}
          <span>{FOLLOW_UP_LABELS[f.kind]}</span>
          {p.showOwner && f.owner ? <span>{f.owner}</span> : null}
        </p>
        <p class="mt-1 break-words font-semibold">{f.title}</p>
        {p.showCustomer || f.deal_title ? (
          <p class="text-label text-ink-2">
            {p.showCustomer ? <a href={`/customers/${f.customer_id}`}>{f.customer_name}</a> : null}
            {p.showCustomer && f.kind === "call" && f.customer_phone ? <> · <a href={`tel:${f.customer_phone.replace(/[^0-9+]/g, "")}`}>{f.customer_phone}</a></> : null}
            {f.deal_title && f.deal_id ? <>{p.showCustomer ? " · " : ""}<a href={`/deals/${f.deal_id}`}>{f.deal_title}</a></> : null}
          </p>
        ) : null}
      </div>
      <div class="flex flex-wrap items-start gap-2">
        <form method="post" action={`/follow-ups/${f.id}/done`}>
          <input type="hidden" name="return" value={p.returnTo} />
          <button class={primaryClass} aria-label={`Done: ${label}`}>Done</button>
        </form>
        <details class="relative">
          <summary class={buttonClass + " cursor-pointer list-none"} aria-label={`More for ${label}`}>More</summary>
          <div class="mt-2 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-card border border-line bg-surface p-3 shadow-lift sm:absolute sm:right-0 sm:z-10">
            <form method="post" action={`/follow-ups/${f.id}/done`} class="flex flex-col gap-2">
              <input type="hidden" name="return" value={p.returnTo} />
              <Field label="What came of it">
                <textarea name="outcome" rows={2} maxlength={10000} class={controlClass}></textarea>
              </Field>
              <button class={buttonClass + " self-start"}>Done, with this note</button>
            </form>
            <div class="flex flex-col gap-2">
              <span class="text-label text-ink-2">Move to</span>
              <div class="flex flex-wrap gap-2">
                {[["Tomorrow", addDays(today, 1)], ["Next week", addDays(today, 7)]].map(([text, day]) => (
                  <form method="post" action={`/follow-ups/${f.id}/move`}>
                    <input type="hidden" name="return" value={p.returnTo} />
                    <input type="hidden" name="on" value={day} />
                    <button class={buttonClass}>{text}</button>
                  </form>
                ))}
              </div>
              <form method="post" action={`/follow-ups/${f.id}/move`} class="flex flex-wrap items-end gap-2">
                <input type="hidden" name="return" value={p.returnTo} />
                <input name="on" type="date" required value={f.due_on} aria-label="Day" class={controlClass} />
                <input name="at" type="time" value={f.due_time ?? ""} aria-label="Time, or blank for any time" class={controlClass} />
                <button class={buttonClass}>Move</button>
              </form>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}

/** Someone in play with nothing planned: how quiet, their open deals, and one click to plan a call. */
function UnplannedRow({ u, today, returnTo, user }: { u: Unplanned; today: string; returnTo: string; user: string }) {
  return (
    <li class="flex flex-col gap-2 border-b border-line px-4 py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4">
      <div class="min-w-0 flex-1">
        <p class="break-words">
          <a href={`/customers/${u.id}`} class="font-semibold">{u.name}</a>
          {u.phone ? <span class="text-ink-2"> · <span class="whitespace-nowrap">{u.phone}</span></span> : u.email ? <span class="text-ink-2"> · {u.email}</span> : null}
        </p>
        <p class="text-label text-ink-3">
          {u.contacted
            ? u.quiet_days <= 0 ? "In touch today" : u.quiet_days === 1 ? "Quiet for a day" : `Quiet for ${u.quiet_days} days`
            : u.quiet_days <= 0 ? "Added today, no contact yet" : `Added ${u.quiet_days === 1 ? "a day" : `${u.quiet_days} days`} ago, no contact yet`}
          {u.deals.length ? ` · ${u.deals.join(", ")}` : ""}
          {u.owner ? ` · ${ownerLabel}: ${u.owner}` : ""}
        </p>
      </div>
      <form method="post" action={`/customers/${u.id}/follow-ups`}>
        <input type="hidden" name="return" value={returnTo} />
        <input type="hidden" name="kind" value="call" />
        <input type="hidden" name="title" value={`Call ${u.name}`} />
        <input type="hidden" name="on" value={addDays(today, 1)} />
        <input type="hidden" name="owner" value={u.owner ?? user} />
        <button class={buttonClass}>Call them tomorrow</button>
      </form>
    </li>
  );
}

/**
 * Add a follow-up for a customer: what kind, what, which day (and time),
 * whose, and which of their open deals it is for.
 */
export function FollowUpForm(p: {
  customerId: string;
  deals: { id: string; title: string }[];
  dealId?: string | null;
  owners: string[];
  user: string;
  today: string;
  returnTo: string;
  title?: string;
}) {
  return (
    <form method="post" action={`/customers/${p.customerId}/follow-ups`} aria-label="Add a follow-up" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <input type="hidden" name="return" value={p.returnTo} />
      <Field label="Kind">
        <select name="kind" class={controlClass}>
          {FOLLOW_UP_KINDS.map((k) => <option value={k}>{FOLLOW_UP_LABELS[k]}</option>)}
        </select>
      </Field>
      <Field label="What to do" class="sm:col-span-1 lg:col-span-3">
        <input name="title" required maxlength={200} value={p.title ?? ""} placeholder="Call back about the quote" class={controlClass} />
      </Field>
      <Field label="Day">
        <input name="on" type="date" required value={addDays(p.today, 1)} class={controlClass} />
      </Field>
      <Field label="Time" hint="Blank for any time that day.">
        <input name="at" type="time" class={controlClass} />
      </Field>
      <Field label="Whose">
        <input name="owner" list="fu-owners" value={p.user} maxlength={200} class={controlClass} />
        <datalist id="fu-owners">
          {p.owners.map((o) => <option value={o} />)}
        </datalist>
      </Field>
      {p.deals.length ? (
        <Field label={`For which ${dealsCfg.one.toLowerCase()}`}>
          <select name="deal" class={controlClass}>
            <option value="">None</option>
            {p.deals.map((d) => <option value={d.id} selected={d.id === p.dealId}>{d.title}</option>)}
          </select>
        </Field>
      ) : null}
      <div class="sm:col-span-2 lg:col-span-4">
        <button class={primaryClass}>Add follow-up</button>
      </div>
    </form>
  );
}

/** The follow-ups on a customer's (or a deal's) page: the open ones with Done and Move, the last few done, and the form. */
export function FollowUpsSection(p: {
  customerId: string;
  open: FollowUp[];
  done: FollowUp[];
  deals: { id: string; title: string }[];
  dealId?: string | null;
  owners: string[];
  user: string;
  today: string;
  returnTo: string;
}) {
  return (
    <div class="flex flex-col gap-4">
      {p.open.length ? (
        <ol class="flex flex-col gap-3">
          {p.open.map((f) => (
            <li class="border-l-2 border-line pl-3">
              <FollowUpItem f={f} today={p.today} returnTo={p.returnTo} showOwner />
            </li>
          ))}
        </ol>
      ) : (
        <p class="font-semibold">Nothing planned. What happens next?</p>
      )}
      <details open={!p.open.length}>
        <summary class="cursor-pointer text-label font-semibold text-ink-2">{p.open.length ? "Add another" : "Plan the next step"}</summary>
        <div class="mt-3">
          <FollowUpForm customerId={p.customerId} deals={p.deals} dealId={p.dealId} owners={p.owners} user={p.user} today={p.today} returnTo={p.returnTo} />
        </div>
      </details>
      {p.done.length ? (
        <details>
          <summary class="cursor-pointer text-label text-ink-2">Done lately</summary>
          <ul class="mt-2 flex flex-col gap-1 text-label text-ink-2">
            {p.done.map((f) => (
              <li>
                {FOLLOW_UP_LABELS[f.kind]}: {f.title}
                <span class="text-ink-3"> · done <When at={f.done_at} timeZone={timeZone} />{f.done_by ? ` by ${f.done_by}` : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

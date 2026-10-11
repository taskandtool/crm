// Follow-ups: the list the team starts the day on (Due: overdue first, then
// today; Upcoming; Nothing planned), mine or everyone's, and the pieces the
// customer and deal pages share: one follow-up with Done and Move, and the
// form that adds one. Plain forms; every change is a POST answered with a
// 303 back to where it came from.
import type { Child } from "hono/jsx";
import { Flash } from "../admin/flash";
import { When } from "../admin/list";
import { listUrl } from "../admin/query";
import { dealsCfg, ownerLabel } from "../config";
import { addDays, FOLLOW_UP_KINDS, FOLLOW_UP_LABELS, UPCOMING_DAYS, type FollowUp, type FollowUpView, type Unplanned } from "../crm/follow-ups";
import { Layout } from "./layout";
import { AddToggle, buttonClass, controlClass, dueDayText, DueMark, Field, MESSAGES, primaryClass, timeText, timeZone } from "./ui";

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
          {tab("upcoming", "Upcoming")}
          {tab("none", "Nothing scheduled")}
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
            Open leads and {dealsCfg.many.toLowerCase()} with nothing scheduled, longest without contact first.
          </p>
          {p.unplanned.length ? (
            <ol class="flex flex-col overflow-hidden rounded-card border border-line bg-surface shadow-card">
              {p.unplanned.map((u) => <UnplannedRow u={u} today={p.today} returnTo={self} user={p.user} />)}
            </ol>
          ) : (
            <Empty>Every open lead and {dealsCfg.one.toLowerCase()} has something scheduled.</Empty>
          )}
        </>
      ) : p.rows.length ? (
        // Headed by day, as task lists are: Overdue and Today under Due, each coming day under Upcoming.
        <div class="flex flex-col gap-4">
          {groups(p.rows, p.today).map(([heading, rows]) => (
            <section aria-label={heading}>
              <h2 class={"mb-2 text-label font-semibold " + (heading === "Overdue" ? "text-late" : "text-ink-2")}>{heading}</h2>
              <ol class="flex flex-col rounded-card border border-line bg-surface shadow-card">
                {rows.map((f) => (
                  <li class="border-b border-line px-4 py-3 last:border-b-0">
                    <FollowUpItem f={f} today={p.today} returnTo={self} showCustomer showOwner={!p.mine} grouped />
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      ) : (
        <Empty>
          {p.view === "due" ? "Nothing due. " : `Nothing in the next ${UPCOMING_DAYS} days. `}
          <a href={href("none")}>See who has nothing scheduled</a>
        </Empty>
      )}
      {p.more ? <p class="mt-3 text-label text-ink-3">The first {p.view === "none" ? p.unplanned.length : p.rows.length}; tick some off to see the rest.</p> : null}
    </Layout>
  );
}

/** The rows under their headings, in the order they came: Overdue, Today, then each day. */
function groups(rows: FollowUp[], today: string): [string, FollowUp[]][] {
  const out: [string, FollowUp[]][] = [];
  for (const f of rows) {
    const heading = f.due_on < today ? "Overdue" : dueDayText(f.due_on, today);
    const last = out[out.length - 1];
    if (last && last[0] === heading) last[1].push(f);
    else out.push([heading, [f]]);
  }
  return out;
}

function Empty({ children }: { children: Child }) {
  return <div class="rounded-card border border-line bg-surface shadow-card px-4 py-8 text-center text-ink-2">{children}</div>;
}

/**
 * One follow-up, as a task list shows one: a circle to tick it done, what and
 * for whom, and Reschedule (with "done, with a note" in the same menu).
 * `grouped` is in a list headed by its day, so only an overdue one says its date.
 */
export function FollowUpItem(p: {
  f: FollowUp; today: string; returnTo: string; showCustomer?: boolean; showOwner?: boolean; grouped?: boolean;
  /** The deal whose page this is: no link back to it. */ onDeal?: string | null;
}) {
  const { f, today } = p;
  const label = `${FOLLOW_UP_LABELS[f.kind]}: ${f.title}`;
  const deal = f.deal_title && f.deal_id && f.deal_id !== p.onDeal;
  const overdue = f.due_on < today;
  return (
    <div class="flex items-start gap-3">
      <form method="post" action={`/follow-ups/${f.id}/done`} class="pt-0.5">
        <input type="hidden" name="return" value={p.returnTo} />
        <button aria-label={`Mark done: ${label}`} title="Mark done"
          class="flex size-5 items-center justify-center rounded-full border-2 border-line-strong text-transparent hover:border-accent hover:bg-accent/10 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          <svg aria-hidden="true" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3"><path d="m2.5 6.5 2.5 2.5 4.5-5" /></svg>
        </button>
      </form>
      <div class="min-w-0 flex-1">
        <p class="break-words font-semibold">{f.title}</p>
        <p class="mt-0.5 flex flex-wrap items-center gap-x-2 text-label text-ink-3">
          {/* Under a day's heading only the time is new; under Overdue, which day it was. */}
          {!p.grouped ? <DueMark next={f} today={today} /> : overdue ? <span class="font-semibold text-late">{dueDayText(f.due_on, today)}</span> : f.due_time ? <span>{timeText(f.due_time)}</span> : null}
          {overdue && f.due_time ? <span>{timeText(f.due_time)}</span> : null}
          <span>{FOLLOW_UP_LABELS[f.kind]}</span>
          {p.showOwner && f.owner ? <span>{f.owner}</span> : null}
        </p>
        {p.showCustomer || deal ? (
          <p class="mt-0.5 text-label text-ink-2">
            {p.showCustomer ? <a href={`/customers/${f.customer_id}`}>{f.customer_name}</a> : null}
            {p.showCustomer && f.kind === "call" && f.customer_phone ? <> · <a href={`tel:${f.customer_phone.replace(/[^0-9+]/g, "")}`}>{f.customer_phone}</a></> : null}
            {deal ? <>{p.showCustomer ? " · " : ""}<a href={`/deals/${f.deal_id}`}>{f.deal_title}</a></> : null}
          </p>
        ) : null}
      </div>
      <details class="relative shrink-0">
        <summary class={buttonClass + " cursor-pointer list-none"} aria-label={`Reschedule ${label}`}>Reschedule</summary>
        <div class="absolute right-0 z-10 mt-2 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-card border border-line bg-surface p-3 shadow-lift">
          <div class="flex flex-wrap gap-2">
            {[["Tomorrow", addDays(today, 1)], ["Next week", addDays(today, 7)]].map(([text, day]) => (
              <form method="post" action={`/follow-ups/${f.id}/move`}>
                <input type="hidden" name="return" value={p.returnTo} />
                <input type="hidden" name="on" value={day} />
                <button class={buttonClass}>{text}</button>
              </form>
            ))}
          </div>
          {/* A day and a time side by side, then the button: they fit the menu's width. */}
          <form method="post" action={`/follow-ups/${f.id}/move`} class="grid grid-cols-2 gap-2">
            <input type="hidden" name="return" value={p.returnTo} />
            <input name="on" type="date" required value={f.due_on} aria-label="Day" class={controlClass + " min-w-0"} />
            <input name="at" type="time" value={f.due_time ?? ""} aria-label="Time, or blank for any time" class={controlClass + " min-w-0"} />
            <button class={buttonClass + " col-span-2"}>Reschedule</button>
          </form>
          <form method="post" action={`/follow-ups/${f.id}/done`} class="flex flex-col gap-2 border-t border-line pt-3">
            <input type="hidden" name="return" value={p.returnTo} />
            <Field label="Or mark it done, with what came of it">
              <textarea name="outcome" rows={2} maxlength={10000} class={controlClass}></textarea>
            </Field>
            <button class={buttonClass + " self-start"}>Mark done</button>
          </form>
        </div>
      </details>
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
            ? u.quiet_days <= 0 ? "Last contacted today" : u.quiet_days === 1 ? "Last contacted yesterday" : `Last contacted ${u.quiet_days} days ago`
            : u.quiet_days <= 0 ? "Never contacted, added today" : `Never contacted, added ${u.quiet_days === 1 ? "yesterday" : `${u.quiet_days} days ago`}`}
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
        <button class={buttonClass}>Call tomorrow</button>
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
    <form method="post" action={`/customers/${p.customerId}/follow-ups`} aria-label="Add a follow-up" class="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="return" value={p.returnTo} />
      <Field label="Title" class="sm:col-span-2">
        <input name="title" required maxlength={200} value={p.title ?? ""} placeholder="Call back about the quote" class={controlClass} />
      </Field>
      <Field label="Type">
        <select name="kind" class={controlClass}>
          {FOLLOW_UP_KINDS.map((k) => <option value={k}>{FOLLOW_UP_LABELS[k]}</option>)}
        </select>
      </Field>
      <Field label="Due date">
        <input name="on" type="date" required value={addDays(p.today, 1)} class={controlClass} />
      </Field>
      <Field label="Time" hint="Optional.">
        <input name="at" type="time" class={controlClass} />
      </Field>
      <Field label="Assigned to">
        <input name="owner" list="fu-owners" value={p.user} maxlength={200} class={controlClass} />
        <datalist id="fu-owners">
          {p.owners.map((o) => <option value={o} />)}
        </datalist>
      </Field>
      {p.deals.length ? (
        <Field label={dealsCfg.one}>
          <select name="deal" class={controlClass}>
            <option value="">None</option>
            {p.deals.map((d) => <option value={d.id} selected={d.id === p.dealId}>{d.title}</option>)}
          </select>
        </Field>
      ) : null}
      <div class="sm:col-span-2">
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
  /** False on a won or lost deal: no "No follow-up scheduled", and the form starts closed. */
  prompt?: boolean;
}) {
  const prompt = p.prompt !== false;
  return (
    <div class="flex flex-col gap-4">
      {p.open.length ? (
        <ol class="flex flex-col gap-3">
          {p.open.map((f) => (
            <li class="border-l-2 border-line pl-3">
              <FollowUpItem f={f} today={p.today} returnTo={p.returnTo} showOwner onDeal={p.dealId} />
            </li>
          ))}
        </ol>
      ) : prompt ? (
        <p class="font-semibold">No follow-up scheduled.</p>
      ) : null}
      <AddToggle label="Add follow-up" open={prompt && !p.open.length}>
        <FollowUpForm customerId={p.customerId} deals={p.deals} dealId={p.dealId} owners={p.owners} user={p.user} today={p.today} returnTo={p.returnTo} />
      </AddToggle>
      {p.done.length ? (
        <details>
          <summary class="cursor-pointer text-label text-ink-2">Completed</summary>
          <ul class="mt-2 flex flex-col gap-1 text-label text-ink-2">
            {p.done.map((f) => (
              <li>
                {FOLLOW_UP_LABELS[f.kind]}: {f.title}
                <span class="text-ink-3"> · <When at={f.done_at} timeZone={timeZone} />{f.done_by ? ` by ${f.done_by}` : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

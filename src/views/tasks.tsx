// Tasks, as HubSpot's and Todoist's: Today (overdue first, then today) and
// Upcoming, mine or everyone's, New task; and the pieces the customer and
// deal pages share: one task with Done and Reschedule, and the form that adds
// one. Plain forms; every change is a POST answered with a 303 back to where
// it came from.
import { Flash } from "../admin/flash";
import { EmptyCard, When } from "../admin/list";
import { listUrl } from "../admin/query";
import { dealsCfg, vocab } from "../config";
import { addDays, TASK_KINDS, TASK_LABELS, UPCOMING_DAYS, type Task, type TaskView } from "../crm/tasks";
import { Layout } from "./layout";
import { AddToggle, buttonClass, controlClass, dueDayText, DueMark, Field, MESSAGES, CustomerPicker, primaryClass, timeText, timeZone } from "./ui";

export type TasksProps = {
  user: string;
  view: TaskView;
  mine: boolean;
  today: string;
  rows: Task[];
  /** More than the page shows. */
  more: boolean;
  counts: { overdue: number; today: number };
  flash: { code?: string | null; n?: string | null };
};

export function TasksPage(p: TasksProps) {
  const href = (view: TaskView, all = !p.mine) => listUrl("/tasks", { view: view === "today" ? null : view, who: all ? "all" : null });
  const self = href(p.view);
  const due = p.counts.overdue + p.counts.today;
  const pill = (on: boolean) => "rounded-control px-2 py-1 no-underline " + (on ? "bg-panel font-semibold" : "text-ink-2 hover:bg-panel");
  return (
    <Layout title="Tasks" user={p.user} section="tasks" actions={<a href="/tasks/new" class={primaryClass}>New task</a>}>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3 text-label">
        <nav aria-label="Which tasks" class="flex flex-wrap gap-1">
          <a href={href("today")} aria-current={p.view === "today" ? "page" : undefined} class={pill(p.view === "today")}>{due ? `Today (${due})` : "Today"}</a>
          <a href={href("upcoming")} aria-current={p.view === "upcoming" ? "page" : undefined} class={pill(p.view === "upcoming")}>Upcoming</a>
        </nav>
        <nav aria-label="Whose" class="flex gap-1">
          <a href={href(p.view, false)} aria-current={p.mine ? "page" : undefined} class={pill(p.mine)}>Mine</a>
          <a href={href(p.view, true)} aria-current={!p.mine ? "page" : undefined} class={pill(!p.mine)}>Everyone</a>
        </nav>
      </div>
      {p.rows.length ? (
        // Headed by day, as task lists are: Overdue and Today under Today, each coming day under Upcoming.
        <div class="flex flex-col gap-4">
          {groups(p.rows, p.today).map(([heading, rows]) => (
            <section aria-label={heading}>
              <h2 class={"mb-2 text-label font-semibold " + (heading === "Overdue" ? "text-late" : "text-ink-2")}>{heading}</h2>
              <ol class="flex flex-col rounded-card border border-line bg-surface shadow-card">
                {rows.map((f) => (
                  <li class="border-b border-line px-4 py-3 last:border-b-0">
                    <TaskItem f={f} today={p.today} returnTo={self} showCustomer showOwner={!p.mine} grouped />
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      ) : (
        <EmptyCard
          title={p.view === "today" ? "Nothing to do today." : `Nothing in the next ${UPCOMING_DAYS} days.`}
          action={<a href="/tasks/new" class={primaryClass}>New task</a>}
        >
          A task is a call, email, visit or to-do for one of your {vocab.many.toLowerCase()}, on a day. Add one here or from their page.
        </EmptyCard>
      )}
      {p.more ? <p class="mt-3 text-label text-ink-3">The first {p.rows.length}; tick some off to see the rest.</p> : null}
    </Layout>
  );
}

/** A task for anyone, from the Tasks page: who it is for (matched by email or phone, or added), then the task. */
export function NewTaskPage(p: { user: string; owners: string[]; today: string; customers: { id: string; name: string; email: string | null }[]; flash: { code?: string | null; n?: string | null } }) {
  return (
    <Layout title="New task" user={p.user} section="tasks" back={{ href: "/tasks", label: "Tasks" }}>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <form method="post" action="/tasks" class="grid max-w-3xl gap-3 rounded-card border border-line bg-surface p-4 shadow-card sm:grid-cols-2">
        <CustomerPicker customers={p.customers} />
        <TaskFields owners={p.owners} user={p.user} today={p.today} deals={[]} />
        <div class="sm:col-span-2">
          <button class={primaryClass}>Create task</button>
        </div>
      </form>
    </Layout>
  );
}

/** The rows under their headings, in the order they came: Overdue, Today, then each day. */
function groups(rows: Task[], today: string): [string, Task[]][] {
  const out: [string, Task[]][] = [];
  for (const f of rows) {
    const heading = f.due_on < today ? "Overdue" : dueDayText(f.due_on, today);
    const last = out[out.length - 1];
    if (last && last[0] === heading) last[1].push(f);
    else out.push([heading, [f]]);
  }
  return out;
}

/**
 * One task, as a task list shows one: a circle to tick it done, what and
 * for whom, and Reschedule (with "done, with a note" in the same menu).
 * `grouped` is in a list headed by its day, so only an overdue one says its date.
 */
export function TaskItem(p: {
  f: Task; today: string; returnTo: string; showCustomer?: boolean; showOwner?: boolean; grouped?: boolean;
  /** The deal whose page this is: no link back to it. */ onDeal?: string | null;
}) {
  const { f, today } = p;
  const label = `${TASK_LABELS[f.kind]}: ${f.title}`;
  const deal = f.deal_title && f.deal_id && f.deal_id !== p.onDeal;
  const overdue = f.due_on < today;
  return (
    <div class="flex items-start gap-3">
      <form method="post" action={`/tasks/${f.id}/done`} class="pt-0.5">
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
          <span>{TASK_LABELS[f.kind]}</span>
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
              <form method="post" action={`/tasks/${f.id}/move`}>
                <input type="hidden" name="return" value={p.returnTo} />
                <input type="hidden" name="on" value={day} />
                <button class={buttonClass}>{text}</button>
              </form>
            ))}
          </div>
          {/* A day and a time side by side, then the button: they fit the menu's width. */}
          <form method="post" action={`/tasks/${f.id}/move`} class="grid grid-cols-2 gap-2">
            <input type="hidden" name="return" value={p.returnTo} />
            <input name="on" type="date" required value={f.due_on} aria-label="Day" class={controlClass + " min-w-0"} />
            <input name="at" type="time" value={f.due_time ?? ""} aria-label="Time, or blank for any time" class={controlClass + " min-w-0"} />
            <button class={buttonClass + " col-span-2"}>Reschedule</button>
          </form>
          <form method="post" action={`/tasks/${f.id}/done`} class="flex flex-col gap-2 border-t border-line pt-3">
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

/**
 * Add a task for a customer: what kind, what, which day (and time),
 * whose, and which of their open deals it is for.
 */
export function TaskForm(p: {
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
    <form method="post" action={`/customers/${p.customerId}/tasks`} aria-label="Add a task" class="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="return" value={p.returnTo} />
      <TaskFields {...p} />
      <div class="sm:col-span-2">
        <button class={buttonClass}>Add task</button>
      </div>
    </form>
  );
}

/** A task's own fields: what, its type, the day (and time), whose, and which open deal it is for. */
function TaskFields(p: { deals: { id: string; title: string }[]; dealId?: string | null; owners: string[]; user: string; today: string; title?: string }) {
  return (
    <>
      <Field label="Task" class="sm:col-span-2">
        <input name="title" required maxlength={200} value={p.title ?? ""} placeholder="Call back about the quote" class={controlClass} />
      </Field>
      <Field label="Type">
        <select name="kind" class={controlClass}>
          {TASK_KINDS.map((k) => <option value={k}>{TASK_LABELS[k]}</option>)}
        </select>
      </Field>
      <Field label="Due date">
        <input name="on" type="date" required value={addDays(p.today, 1)} class={controlClass} />
      </Field>
      <Field label="Time" hint="Optional.">
        <input name="at" type="time" class={controlClass} />
      </Field>
      <Field label="Assigned to">
        <input name="owner" list="task-owners" value={p.user} maxlength={200} class={controlClass} />
        <datalist id="task-owners">
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
    </>
  );
}

/** The tasks on a customer's (or a deal's) page: the open ones with Done and Move, the last few done, and the form. */
export function TasksSection(p: {
  customerId: string;
  open: Task[];
  done: Task[];
  deals: { id: string; title: string }[];
  dealId?: string | null;
  owners: string[];
  user: string;
  today: string;
  returnTo: string;
  /** False on a won or lost deal: no "No task scheduled", and the form starts closed. */
  prompt?: boolean;
}) {
  const prompt = p.prompt !== false;
  return (
    <div class="flex flex-col gap-4">
      {p.open.length ? (
        <ol class="flex flex-col gap-3">
          {p.open.map((f) => (
            <li class="border-l-2 border-line pl-3">
              <TaskItem f={f} today={p.today} returnTo={p.returnTo} showOwner onDeal={p.dealId} />
            </li>
          ))}
        </ol>
      ) : prompt ? (
        <p class="font-semibold">No task scheduled.</p>
      ) : null}
      <AddToggle label="Add task" open={prompt && !p.open.length}>
        <TaskForm customerId={p.customerId} deals={p.deals} dealId={p.dealId} owners={p.owners} user={p.user} today={p.today} returnTo={p.returnTo} />
      </AddToggle>
      {p.done.length ? (
        <details>
          <summary class="cursor-pointer text-label text-ink-2">Completed</summary>
          <ul class="mt-2 flex flex-col gap-1 text-label text-ink-2">
            {p.done.map((f) => (
              <li>
                {TASK_LABELS[f.kind]}: {f.title}
                <span class="text-ink-3"> · <When at={f.done_at} timeZone={timeZone} />{f.done_by ? ` by ${f.done_by}` : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

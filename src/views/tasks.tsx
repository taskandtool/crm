// Tasks, as HubSpot's and Todoist's open task lists: every open task, soonest
// first under its day (Overdue first, in red), everyone's or mine, New task;
// and the pieces the customer and
// deal pages share: one task with Done and Reschedule, and the form that adds
// one. Plain forms; every change is a POST answered with a 303 back to where
// it came from.
import { Flash } from "../admin/flash";
import { EmptyCard, When } from "../admin/list";
import { listUrl } from "../admin/query";
import { dealsCfg, vocab } from "../config";
import { addDays, TASK_KINDS, TASK_LABELS, type Task } from "../crm/tasks";
import { Layout } from "./layout";
import { AddToggle, buttonClass, controlClass, dueDayText, DueMark, Field, MESSAGES, CustomerPicker, primaryClass, telHref, timeText, timeZone, quietClass, ViewLink, viewsClass } from "./ui";
import { ownerSuggestions, personName } from "../crm/people";

export type TasksProps = {
  user: string;
  /** Only the viewer's; everyone's by default. */
  mine: boolean;
  today: string;
  rows: Task[];
  /** More than the page shows. */
  more: boolean;
  flash: { code?: string | null; n?: string | null };
};

export function TasksPage(p: TasksProps) {
  const href = (mine: boolean) => listUrl("/tasks", { who: mine ? "mine" : null });
  const self = href(p.mine);
  return (
    <Layout title="Tasks" user={p.user} section="tasks" actions={<a href="/tasks/new" class={primaryClass}>New task</a>}>
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <div class="mb-6">
        <nav aria-label="Whose" class={viewsClass}>
          <ViewLink href={href(false)} on={!p.mine}>Everyone</ViewLink>
          <ViewLink href={href(true)} on={p.mine}>Mine</ViewLink>
        </nav>
      </div>
      {p.rows.length ? (
        // Headed by day, as task lists are: Overdue, Today, Tomorrow, then each day after.
        <div class="flex flex-col gap-4">
          {groups(p.rows, p.today).map(([heading, rows]) => (
            <section aria-label={heading}>
              <h2 class={"mb-2 text-label font-semibold " + (heading === "Overdue" ? "text-late" : "text-ink-2")}>{heading}</h2>
              <ol class="flex flex-col rounded-card border border-line bg-surface shadow-card">
                {rows.map((task) => (
                  <li class="border-b border-line px-4 py-3 last:border-b-0">
                    <TaskItem task={task} today={p.today} returnTo={self} showCustomer showOwner={!p.mine} grouped />
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      ) : (
        <EmptyCard
          title={p.mine ? "Nothing on your list." : "Nothing to do."}
          action={<a href="/tasks/new" class={buttonClass}>New task</a>}
        >
          A task is a call, email, meeting or to-do for one of your {vocab.many.toLowerCase()}, on a day. Add one here or from their page.
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
  for (const task of rows) {
    const heading = task.due_on < today ? "Overdue" : dueDayText(task.due_on, today);
    const last = out[out.length - 1];
    if (last && last[0] === heading) last[1].push(task);
    else out.push([heading, [task]]);
  }
  return out;
}

/**
 * One task, as a task list shows one: a circle to tick it done, what and
 * for whom, and Reschedule (with "done, with a note" in the same menu).
 * `grouped` is in a list headed by its day, so only an overdue one says its date.
 */
export function TaskItem(p: {
  task: Task; today: string; returnTo: string; showCustomer?: boolean; showOwner?: boolean; grouped?: boolean;
  /** The deal whose page this is: no link back to it. */ onDeal?: string | null;
}) {
  const { task, today } = p;
  const label = `${TASK_LABELS[task.kind]}: ${task.title}`;
  const deal = task.deal_title && task.deal_id && task.deal_id !== p.onDeal;
  const overdue = task.due_on < today;
  return (
    <div class="flex items-start gap-3">
      <form method="post" action={`/tasks/${task.id}/done`} class="pt-0.5">
        <input type="hidden" name="return" value={p.returnTo} />
        <button aria-label={`Mark done: ${label}`} title="Mark done"
          class="flex size-5 items-center justify-center rounded-full border-2 border-line-strong text-transparent hover:border-accent hover:bg-accent/10 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          <svg aria-hidden="true" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3"><path d="m2.5 6.5 2.5 2.5 4.5-5" /></svg>
        </button>
      </form>
      <div class="min-w-0 flex-1">
        <p class="break-words font-semibold">{task.title}</p>
        <p class="mt-0.5 flex flex-wrap items-center gap-x-2 text-label text-ink-3">
          {/* Under a day's heading only the time is new; under Overdue, which day it was. */}
          {!p.grouped ? <DueMark next={task} today={today} /> : overdue ? <span class="font-semibold text-late">{dueDayText(task.due_on, today)}</span> : task.due_time ? <span>{timeText(task.due_time)}</span> : null}
          {overdue && task.due_time ? <span>{timeText(task.due_time)}</span> : null}
          <span>{TASK_LABELS[task.kind]}</span>
          {p.showOwner && task.owner ? <span>{personName(task.owner)}</span> : null}
        </p>
        {p.showCustomer || deal ? (
          <p class="mt-0.5 text-label text-ink-2">
            {p.showCustomer ? <a href={`/customers/${task.customer_id}`}>{task.customer_name}</a> : null}
            {p.showCustomer && task.kind === "call" && task.customer_phone ? <> · <a href={telHref(task.customer_phone)}>{task.customer_phone}</a></> : null}
            {deal ? <>{p.showCustomer ? " · " : ""}<a href={`/deals/${task.deal_id}`}>{task.deal_title}</a></> : null}
          </p>
        ) : null}
      </div>
      <details data-menu class="relative shrink-0">
        <summary class={quietClass + " cursor-pointer list-none"} aria-label={`Reschedule ${label}`}>Reschedule</summary>
        <div class="absolute right-0 z-10 mt-2 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-card border border-line bg-surface p-3 shadow-lift">
          <div class="flex flex-wrap gap-2">
            {[["Tomorrow", addDays(today, 1)], ["Next week", addDays(today, 7)]].map(([text, day]) => (
              <form method="post" action={`/tasks/${task.id}/move`}>
                <input type="hidden" name="return" value={p.returnTo} />
                <input type="hidden" name="on" value={day} />
                <button class={buttonClass}>{text}</button>
              </form>
            ))}
          </div>
          {/* A day and a time side by side, then the button: they fit the menu's width. */}
          <form method="post" action={`/tasks/${task.id}/move`} class="grid grid-cols-2 gap-2">
            <input type="hidden" name="return" value={p.returnTo} />
            <input name="on" type="date" required value={task.due_on} aria-label="Day" class={controlClass + " min-w-0"} />
            <input name="at" type="time" value={task.due_time ?? ""} aria-label="Time, or blank for any time" class={controlClass + " min-w-0"} />
            <button class={buttonClass + " col-span-2"}>Reschedule</button>
          </form>
          <form method="post" action={`/tasks/${task.id}/done`} class="flex flex-col gap-2 border-t border-line pt-3">
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
function TaskFields(p: { deals: { id: string; title: string }[]; dealId?: string | null; owners: string[]; user: string; today: string }) {
  return (
    <>
      <Field label="Task" class="sm:col-span-2">
        <input name="title" required maxlength={200} placeholder="Call back about the quote" class={controlClass} />
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
        <input name="owner" list="task-owners" value={personName(p.user)} maxlength={200} class={controlClass} />
        <datalist id="task-owners">
          {ownerSuggestions(p.owners).map((o) => <option value={o} />)}
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
  /** False on a won or lost deal: no "No task scheduled". */
  prompt?: boolean;
}) {
  const prompt = p.prompt !== false;
  return (
    <div class="flex flex-col gap-4">
      {p.open.length ? (
        <ol class="flex flex-col gap-3">
          {p.open.map((task) => (
            <li class="border-l-2 border-line pl-3">
              <TaskItem task={task} today={p.today} returnTo={p.returnTo} showOwner onDeal={p.dealId} />
            </li>
          ))}
        </ol>
      ) : prompt ? (
        <p class="font-semibold">No task scheduled.</p>
      ) : null}
      <AddToggle label="Add task">
        <TaskForm customerId={p.customerId} deals={p.deals} dealId={p.dealId} owners={p.owners} user={p.user} today={p.today} returnTo={p.returnTo} />
      </AddToggle>
      {p.done.length ? (
        <details>
          <summary class="cursor-pointer text-label text-ink-2">Completed tasks</summary>
          <ul class="mt-2 flex flex-col gap-1 text-label text-ink-2">
            {p.done.map((task) => (
              <li>
                {TASK_LABELS[task.kind]}: {task.title}
                <span class="text-ink-3"> · <When at={task.done_at} timeZone={timeZone} />{task.done_by ? ` by ${task.done_by}` : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

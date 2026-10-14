// Small pieces the CRM's pages share: the stage badge,
// a task's day and its mark, the flash messages, a field with its
// label, a custom field's input, the record's "added by" line.
import type { Child } from "hono/jsx";
import type { FlashMessages } from "../admin/flash";
import { BOOKING_MESSAGES } from "../booking/admin";
import { buttonClass, controlClass, fieldClass, primaryClass, quietClass, type StatusOption } from "../admin/status";
import { cfg, dealsCfg, eventsCfg, vocab } from "../config";
import type { CustomField } from "../config-schema";
import { When } from "../admin/list";
import { FieldList, type Field as Shown } from "../admin/detail";
import { fieldText } from "../crm/fields";
import type { Stage } from "../crm/stages";
import { addDays, dueOf, type Due } from "../crm/tasks";
import { Icon } from "./icons";

// One look for every control: the admin skill's, which a link that does an action shares.
export { buttonClass, controlClass, primaryClass, quietClass };

/** Stage options for a select or badge: open stages strong, won in the accent, lost muted. */
export function stageOptions(stages: Stage[]): StatusOption[] {
  return stages.map((s) => ({ value: s.key, label: s.label, tone: s.kind === "won" ? "accent" : s.kind === "lost" ? "muted" : "strong" }));
}

// Literal class names, so Tailwind finds them: one hue per person.
const HUES = [
  "bg-hue-1/12 text-hue-1",
  "bg-hue-2/12 text-hue-2",
  "bg-hue-3/12 text-hue-3",
  "bg-hue-4/12 text-hue-4",
  "bg-hue-5/12 text-hue-5",
  "bg-hue-6/12 text-hue-6",
];

/** "Dana Ortiz" as "DO", "ann@example.com" as "A". */
function initials(name: string): string {
  const words = name.replace(/@.*/, "").split(/[\s._-]+/).filter((w) => /\p{L}|\d/u.test(w));
  return ((words[0]?.[0] ?? "?") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
}

/**
 * A person as their initials on a tint picked from their name, so the same
 * person is the same colour on every page. Decorative where their name is
 * written beside it; `label` says who it is where it stands alone ("Owner:
 * Dana Ortiz" on a card), on hover and to a screen reader.
 */
export function Avatar({ name, size = "md", label }: { name: string; size?: "sm" | "md"; label?: string }) {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return (
    <span class={`inline-flex ${size === "sm" ? "size-6" : "size-8"} shrink-0 text-label select-none items-center justify-center rounded-full font-semibold ${HUES[h % HUES.length]}`}
      {...(label ? { title: label, role: "img", "aria-label": label } : { "aria-hidden": "true" })}>
      {initials(name)}
    </span>
  );
}

/** A label around its control. `quiet` keeps the label for screen readers only on a wide screen, where a row above names the column. */
export function Field(props: { label: string; children: Child; class?: string; hint?: string; quiet?: boolean }) {
  return (
    <label class={fieldClass + " " + (props.class ?? "")}>
      <span class={props.quiet ? "lg:sr-only" : undefined}>{props.label}</span>
      {props.children}
      {props.hint ? <span class="font-normal text-ink-3">{props.hint}</span> : null}
    </label>
  );
}

/**
 * A task's day as the team says it: Today, Tomorrow, Yesterday, else
 * "Fri, Oct 9" (with the year when it is not this one), and its time.
 */
export function dueDayText(day: string, today: string, time?: string | null): string {
  const t = time ? ` ${timeText(time)}` : "";
  if (day === today) return `Today${t}`;
  if (day === addDays(today, 1)) return `Tomorrow${t}`;
  if (day === addDays(today, -1)) return `Yesterday${t}`;
  const d = new Date(day + "T12:00:00Z");
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: sameYear ? undefined : "numeric" }).format(d) + t;
}

/** "14:30" as "2:30 PM". */
export function timeText(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// Late in its colour, at the copy's weight: the words say it, the colour finds it.
const DUE_CLASS: Record<Due, string> = {
  overdue: "font-medium text-late",
  today: "font-medium text-accent",
  later: "text-ink-3",
  none: "text-ink-3",
};

/**
 * The mark on a card or a row: when the next task is, in words, or that
 * nothing is planned. `task` names it as the task where nothing else on the
 * line does (a pipeline card), so "Overdue" cannot read as the deal's.
 */
export function DueMark({ next, today, task = false }: { next: { due_on: string; due_time: string | null } | undefined; today: string; task?: boolean }) {
  const due = dueOf(next, today);
  const when = !next ? "" : due === "overdue" ? dueDayText(next.due_on, today) : dueDayText(next.due_on, today, next.due_time);
  const text = !next
    ? "Nothing planned"
    : due === "overdue"
      ? `${task ? "Task overdue" : "Overdue"}, ${when}`
      : task ? `Task ${when.replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase())}` : when;
  return (
    <span class={"whitespace-nowrap text-label " + DUE_CLASS[due]} title={next ? "Next task" : undefined}>
      {text}
    </span>
  );
}

/**
 * A select that saves as soon as it is chosen (a customer's status, a deal's
 * stage): htmx posts it and swaps in the page the POST redirects to, flash
 * included. Without JavaScript it is a form with a Save button.
 */
/**
 * A list's views (Today, Upcoming; To do, Everything; Mine, Everyone) as a
 * segmented control, as Catalyst's and Apple's: a tinted track, the current
 * view raised on it. `viewsClass` is the track, on the <nav> around them.
 */
export const viewsClass = "inline-flex flex-wrap gap-0.5 rounded-control bg-panel p-0.5";
export function ViewLink({ href, on, children }: { href: string; on: boolean; children: Child }) {
  return (
    <a href={href} aria-current={on ? "page" : undefined}
      class={"rounded-control px-3 py-1 font-medium no-underline " + (on ? "bg-surface text-ink shadow-card ring-1 ring-line" : "text-ink-2 hover:text-ink")}>
      {children}
    </a>
  );
}

/** A custom field's value as a page shows it: a date as the rest of the CRM writes one ("Nov 4"), the rest as typed. */
export function shownField(f: CustomField, value: unknown): string {
  const text = fieldText(value);
  if (f.type !== "date" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const year = text.slice(0, 4) === String(new Date().getUTCFullYear()) ? undefined : "numeric";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year }).format(new Date(`${text}T00:00:00Z`));
}

/** A phone number as a link that dials it. */
export const telHref = (phone: string) => `tel:${phone.replace(/[^0-9+]/g, "")}`;

export function SaveOnChange(p: { action: string; current: string; options: StatusOption[]; label: string; returnTo: string }) {
  return (
    <form method="post" action={p.action} hx-post={p.action} hx-trigger="change" hx-target="main" hx-select="main" hx-swap="outerHTML" class="flex items-center gap-2">
      <input type="hidden" name="return" value={p.returnTo} />
      <label class="flex items-center gap-2 text-label text-ink-2">
        {p.label}
        <select name="status" class={controlClass + " text-copy text-ink"}>
          {p.options.map((o) => (
            <option value={o.value} selected={o.value === p.current}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <noscript>
        <button class={buttonClass}>Save</button>
      </noscript>
    </form>
  );
}

/**
 * A record's details as values, with Edit: the form takes their place while it
 * is open, and Cancel puts them back. Values with nothing in them are left out.
 */
export function ReadThenEdit({ fields, children }: { fields: Shown[]; children: Child }) {
  return (
    <div class="flex flex-col gap-3 [&:has(>details[open])>dl]:hidden">
      <FieldList fields={fields} />
      <details class="group">
        <summary class={buttonClass + " cursor-pointer list-none"}>
          <span class="group-open:hidden">Edit</span>
          <span class="hidden group-open:inline">Cancel</span>
        </summary>
        <div class="mt-4">{children}</div>
      </details>
    </div>
  );
}

/** "+ Add task": a form that opens in place, a quiet button turning to Cancel while it is open. */
export function AddToggle({ label, open, children }: { label: string; open?: boolean; children: Child }) {
  return (
    <details open={open} class="group">
      <summary class={quietClass + " -ml-2.5 cursor-pointer list-none"}>
        <span class="inline-flex items-center gap-1.5 group-open:hidden"><Icon name="plus" class="size-4 text-ink-3" />{label}</span>
        <span class="hidden text-ink-2 group-open:inline">Cancel</span>
      </summary>
      <div class="mt-3">{children}</div>
    </details>
  );
}

/**
 * Who a new task, event or deal is for, as Jobber's "Select a client": a
 * customer already here, or "Someone new", which opens their name, email and
 * phone (matched by email or phone, or added). Spans the whole form's grid.
 */
export function CustomerPicker({ customers, selected, person }: {
  customers: { id: string; name: string; email: string | null }[];
  /** Already chosen (a deal from a lead): this customer, or "new" with `person` filled in. */
  selected?: string | null;
  person?: { name: string | null; email: string | null; phone: string | null };
}) {
  const isNew = selected === "new" || !customers.length;
  return (
    <>
      <Field label={vocab.one} class="col-span-full">
        <select name="customer" required autofocus class={controlClass + " w-full min-w-0"}>
          {customers.length ? <option value="">Choose a {vocab.one.toLowerCase()}</option> : null}
          {customers.map((c) => <option value={c.id} selected={c.id === selected}>{c.email ? `${c.name} (${c.email})` : c.name}</option>)}
          <option value="new" selected={isNew}>Someone new</option>
        </select>
      </Field>
      <div class="col-span-full hidden gap-3 sm:grid-cols-2 [form:has(select[name=customer]>option[value=new]:checked)_&]:grid">
        <PersonFields pairs person={person} />
      </div>
    </>
  );
}

/** Who a new deal or event is for: matched by email or phone, or added. In a two-column form the name takes a row, so email and phone pair up. */
export function PersonFields({ pairs, person }: { pairs?: boolean; person?: { name: string | null; email: string | null; phone: string | null } }) {
  return (
    <>
      <Field label={`${vocab.one} name`} class={pairs ? "sm:col-span-2" : ""}>
        <input name="name" value={person?.name ?? ""} maxlength={200} autocomplete="off" autofocus class={controlClass} />
      </Field>
      <Field label="Email">
        <input name="email" type="email" value={person?.email ?? ""} maxlength={254} autocomplete="off" class={controlClass} />
      </Field>
      <Field label="Phone">
        <input name="phone" type="tel" value={person?.phone ?? ""} maxlength={40} autocomplete="off" class={controlClass} />
      </Field>
    </>
  );
}

/** A custom field's input, named f_<key>, for a customer or an event form. */
export function CustomInput({ f, value }: { f: CustomField; value: unknown }) {
  const v = fieldText(value);
  const name = `f_${f.key}`;
  let input: Child;
  if (f.type === "select") {
    // One "None": the empty choice stands for a "None" the field also lists.
    const isNone = (o: string) => o.trim().toLowerCase() === "none";
    const options = (f.options ?? []).filter((o) => !isNone(o));
    input = (
      <select name={name} class={controlClass}>
        <option value="" selected={!v || isNone(v)}>None</option>
        {options.map((o) => (
          <option value={o} selected={o === v}>
            {o}
          </option>
        ))}
        {v && !isNone(v) && !options.includes(v) ? (
          <option value={v} selected>
            {v}
          </option>
        ) : null}
      </select>
    );
  } else {
    const type = { text: "text", number: "number", date: "date", phone: "tel", email: "email" }[f.type];
    input = <input name={name} type={type} step={f.type === "number" ? "any" : undefined} value={v} maxlength={f.type === "text" ? 2000 : undefined} class={controlClass} />;
  }
  return <Field label={f.label}>{input}</Field>;
}

/** Who added a record and who last changed it, as one quiet line at the foot of its page. */
export function RecordLine({ added, addedBy, changed, changedBy, children }: { added: Date | null; addedBy: string | null; changed?: Date | null; changedBy?: string | null; children?: Child }) {
  const sameEdit = !changed || (added && Math.abs(new Date(changed).getTime() - new Date(added).getTime()) < 60_000);
  return (
    <div class="mt-6 flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-line pt-3 text-label text-ink-3">
      <p class="min-w-0 break-words">
        Added <When at={added} timeZone={timeZone} day />
        {addedBy ? ` by ${addedBy}` : ""}
        {sameEdit ? null : (
          <>
            {" · Changed "}
            <When at={changed} timeZone={timeZone} day />
            {changedBy ? ` by ${changedBy}` : ""}
          </>
        )}
      </p>
      {children}
    </div>
  );
}

const one = vocab.one.toLowerCase();
const eventWord = (eventsCfg ?? { one: "Event" }).one;

export const MESSAGES: FlashMessages = {
  // What the booking skill's routes (an event's buttons, Reschedule) come back with, in this CRM's word.
  ...BOOKING_MESSAGES,
  rescheduled: `${eventWord} moved. They have been told the new time.`,
  cancelled: `${eventWord} cancelled.`,
  unchanged: { error: `Nothing changed. A cancelled ${eventWord.toLowerCase()} stays cancelled, and one is marked completed or no-show only once it has started.` },
  added: `${vocab.one} added.`,
  exists: `That ${one} is already here, so their record opened.`,
  saved: "Saved.",
  invalid: { error: "Saved, except values that were not a valid number, date, time, amount, option or email." },
  stage: "Status changed.",
  "deal-added": `${dealsCfg.one} added.`,
  "deal-saved": `${dealsCfg.one} saved.`,
  "deal-stage": "Stage changed.",
  "deal-title-needed": { error: `Say what the ${dealsCfg.one.toLowerCase()} is first.` },
  "deal-archived": `${dealsCfg.one} archived. Nothing was deleted.`,
  "deal-unarchived": `${dealsCfg.one} is back from the archive.`,
  "task-added": "Task added.",
  "task-done": "Task completed.",
  "task-already": "That task was already done.",
  "task-moved": "Task rescheduled.",
  "task-needs": { error: "Add a title and a due date." },
  merged: "Merged. Everything from the other record is here now.",
  "merge-same": { error: "Choose another record to merge with this one." },
  "merge-gone": { error: "That record is gone or was already merged." },
  note: "Note added.",
  "note-empty": { error: "Write something in the note first." },
  archived: `${vocab.one} archived. Nothing was deleted; Unarchive brings them back.`,
  unarchived: `${vocab.one} is back from the archive.`,
  "lead-added": "Lead added.",
  "lead-archived": "Lead archived.",
  "lead-reopened": "Lead unarchived.",
  "lead-needs": { error: "Add who it is (a name, email or phone) and what they need." },
  "email-taken": { error: `Another ${one} already has that email. Nothing was saved.` },
  "name-needed": { error: "A name, an email or a phone number is needed." },
  gone: { error: "That is no longer there." },
  "stage-added": "Stage added.",
  "stage-saved": "Stage saved.",
  "stage-moved": "Stage moved.",
  "stage-archived": "Stage archived.",
  "stage-restored": "Stage restored, at the end of the pipeline.",
  "stage-in-use": { error: "Something is still in that stage. Choose a stage to move it to, then archive it." },
  "last-open": { error: "Keep at least one open stage in each list: new ones land there." },
  "bad-target": { error: "Choose an active stage to move them to." },
  "pick-stage": { error: "Choose one of the stages." },
  "pick-status": { error: "Choose one of the statuses." },
  "event-added": `${eventWord} added.`,
  "event-incomplete": { error: `Give the ${eventWord.toLowerCase()} a title or a service, and a time.` },
};

export const timeZone = cfg.time_zone;

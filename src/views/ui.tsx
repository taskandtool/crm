// Small pieces the CRM's pages share: the primary button, the stage badge,
// a follow-up's day and its mark, the flash messages, a field with its
// label, a custom field's input, the record's "added by" line.
import type { Child } from "hono/jsx";
import type { FlashMessages } from "../admin/flash";
import { buttonClass, controlClass, type StatusOption } from "../admin/status";
import { cfg, dealsCfg, visitsCfg, vocab } from "../config";
import type { CustomField } from "../config-schema";
import { When } from "../admin/list";
import { fieldText } from "../crm/fields";
import type { Stage } from "../crm/stages";
import { addDays, dueOf, type Due } from "../crm/follow-ups";

export { buttonClass, controlClass };

export const primaryClass =
  "rounded-control border border-accent bg-accent px-3 py-1 text-label font-semibold text-accent-ink hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
export const labelClass = "flex flex-col gap-1 text-label text-ink-2";
/** A link that does an action (call, book, quote): it looks like a button. */
export const linkButtonClass = buttonClass + " inline-block no-underline";
/** The page's one primary action when it is a link ("New customer"). */
export const primaryLinkClass = primaryClass + " inline-block no-underline";

/** Stage options for a select or badge: open stages strong, won in the accent, lost muted. */
export function stageOptions(stages: Stage[]): StatusOption[] {
  return stages.map((s) => ({ value: s.key, label: s.label, tone: s.kind === "won" ? "accent" : s.kind === "lost" ? "muted" : "strong" }));
}

export function Field(props: { label: string; children: Child; class?: string; hint?: string }) {
  return (
    <label class={labelClass + " " + (props.class ?? "")}>
      {props.label}
      {props.children}
      {props.hint ? <span class="text-ink-3">{props.hint}</span> : null}
    </label>
  );
}

/**
 * A follow-up's day as the team says it: Today, Tomorrow, Yesterday, else
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

const DUE_CLASS: Record<Due, string> = {
  overdue: "font-semibold text-late",
  today: "font-semibold text-accent",
  later: "text-ink-3",
  none: "text-ink-3",
};

/** The mark on a card or a row: when the next follow-up is, in words, or that nothing is planned. */
export function DueMark({ next, today }: { next: { due_on: string; due_time: string | null } | undefined; today: string }) {
  const due = dueOf(next, today);
  const text = !next ? "Nothing scheduled" : due === "overdue" ? `Overdue, ${dueDayText(next.due_on, today)}` : dueDayText(next.due_on, today, next.due_time);
  return (
    <span class={"whitespace-nowrap text-label " + DUE_CLASS[due]} title={next ? "Next follow-up" : undefined}>
      {text}
    </span>
  );
}

/**
 * A select that saves as soon as it is chosen (a customer's status, a deal's
 * stage): htmx posts it and swaps in the page the POST redirects to, flash
 * included. Without JavaScript it is a form with a Save button.
 */
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

/** Who a new deal or visit is for: matched by email or phone, or added. */
export function PersonFields() {
  return (
    <>
      <Field label={`${vocab.one} name`}>
        <input name="name" maxlength={200} autocomplete="off" autofocus class={controlClass} />
      </Field>
      <Field label="Email">
        <input name="email" type="email" maxlength={254} autocomplete="off" class={controlClass} />
      </Field>
      <Field label="Phone">
        <input name="phone" type="tel" maxlength={40} autocomplete="off" class={controlClass} />
      </Field>
    </>
  );
}

/** A custom field's input, named f_<key>, for a customer or a visit form. */
export function CustomInput({ f, value }: { f: CustomField; value: unknown }) {
  const v = fieldText(value);
  const name = `f_${f.key}`;
  let input: Child;
  if (f.type === "select") {
    const options = f.options ?? [];
    input = (
      <select name={name} class={controlClass}>
        <option value="">None</option>
        {options.map((o) => (
          <option value={o} selected={o === v}>
            {o}
          </option>
        ))}
        {v && !options.includes(v) ? (
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
    <div class="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3 text-label text-ink-3">
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
const visitWords = visitsCfg ?? { one: "Visit" };

export const MESSAGES: FlashMessages = {
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
  "fu-added": "Follow-up added.",
  "fu-done": "Follow-up completed.",
  "fu-already": "That follow-up was already done.",
  "fu-moved": "Follow-up rescheduled.",
  "fu-needs": { error: "Add a title and a due date." },
  merged: "Merged. Everything from the other record is here now.",
  "merge-same": { error: "Choose another record to merge with this one." },
  "merge-gone": { error: "That record is gone or was already merged." },
  note: "Note added.",
  "note-empty": { error: "Write something in the note first." },
  archived: `${vocab.one} archived. Nothing was deleted; Unarchive brings them back.`,
  unarchived: `${vocab.one} is back from the archive.`,
  done: "Marked done.",
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
  "visit-added": `${visitWords.one} added.`,
  "visit-title-needed": { error: `Say what the ${visitWords.one.toLowerCase()} is for first.` },
  "visit-status": "Status changed.",
};

export const timeZone = cfg.time_zone;

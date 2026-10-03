// Small pieces the CRM's pages share: the primary button, the stage badge,
// the List/Pipeline switch, the flash messages, a field with its label, a
// custom field's input, "when, by whom".
import type { Child } from "hono/jsx";
import type { FlashMessages } from "../admin/flash";
import { buttonClass, controlClass, type StatusOption } from "../admin/status";
import { cfg, showPipeline, visitsCfg, vocab } from "../config";
import type { CustomField } from "../config-schema";
import { When } from "../admin/list";
import { fieldText } from "../crm/fields";
import type { Stage } from "../crm/stages";

export { buttonClass, controlClass };

export const primaryClass =
  "rounded-control border border-accent bg-accent px-3 py-1 text-label font-semibold text-accent-ink hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
export const labelClass = "flex flex-col gap-1 text-label text-ink-2";

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

/** The switch between the list and the pipeline of the same customers. */
export function ViewSwitch({ current }: { current: "list" | "pipeline" }) {
  if (!showPipeline) return null;
  const item = (href: string, label: string, on: boolean) => (
    <a href={href} aria-current={on ? "page" : undefined} class={"rounded-control px-2 py-1 no-underline " + (on ? "bg-panel font-semibold" : "text-ink-2 hover:bg-panel")}>
      {label}
    </a>
  );
  return (
    <nav aria-label="View" class="mb-4 flex gap-1 text-label">
      {item("/customers", "List", current === "list")}
      {item("/pipeline", "Pipeline", current === "pipeline")}
    </nav>
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

/** When something was added or changed, and by whom. */
export function Who({ at, by }: { at: Date | null; by: string | null }) {
  return (
    <>
      <When at={at} timeZone={timeZone} />
      {by ? <span class="text-ink-3"> by {by}</span> : null}
    </>
  );
}

const one = vocab.one.toLowerCase();
const visitWords = visitsCfg ?? { one: "Visit" };

export const MESSAGES: FlashMessages = {
  added: `${vocab.one} added.`,
  exists: `Already a ${one}: here they are.`,
  saved: "Saved.",
  invalid: "Saved, except values that were not a valid number, date, time, amount, option or email.",
  stage: "Stage changed.",
  note: "Note added.",
  "note-empty": "Write something in the note first.",
  archived: `${vocab.one} archived. Nothing was deleted; Unarchive brings them back.`,
  unarchived: `${vocab.one} is back from the archive.`,
  done: "Marked done.",
  "email-taken": `Another ${one} already has that email. Nothing was saved.`,
  "name-needed": "A name, an email or a phone number is needed.",
  gone: "That is no longer there.",
  "stage-added": "Stage added.",
  "stage-saved": "Stage saved.",
  "stage-moved": "Stage moved.",
  "stage-archived": "Stage archived.",
  "stage-restored": "Stage restored, at the end of the pipeline.",
  "stage-in-use": `${vocab.many} are still in that stage. Choose a stage to move them to, then archive it.`,
  "last-open": `Keep at least one open stage: new ${vocab.many.toLowerCase()} land there.`,
  "bad-target": "Choose an active stage to move them to.",
  "pick-stage": "Choose one of the stages.",
  "pick-status": "Choose one of the statuses.",
  "visit-added": `${visitWords.one} added.`,
  "visit-title-needed": `Say what the ${visitWords.one.toLowerCase()} is for first.`,
  "visit-status": "Status changed.",
};

export const timeZone = cfg.time_zone;

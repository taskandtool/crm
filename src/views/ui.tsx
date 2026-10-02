// Small pieces the CRM's pages share: the primary button, the stage badge,
// the List/Pipeline switch, the flash messages, a field with its label.
import type { Child } from "hono/jsx";
import type { FlashMessages } from "../admin/flash";
import { buttonClass, controlClass, type StatusOption } from "../admin/status";
import { cfg, showPipeline, vocab } from "../config";
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

const one = vocab.one.toLowerCase();

export const MESSAGES: FlashMessages = {
  added: `${vocab.one} added.`,
  exists: `Already a ${one}: here they are.`,
  saved: "Saved.",
  invalid: "Saved, except custom fields whose value was not a valid number, date, option or email.",
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
};

export const timeZone = cfg.time_zone;

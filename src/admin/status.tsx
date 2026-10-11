// A status shown as a badge and changed with a form. The form is a plain POST
// that the route answers with a 303; with `swap` set it also posts through
// htmx on change and the route answers with the updated element instead
// (`swap="closest tr"` in a list row). The Save button sits in <noscript>
// there, so a row stays one line with JavaScript and still works without it.
//
//   <StatusForm action={`/admin/${r.id}/status`} current={r.status} options={STATUSES}
//               returnTo={listHref} label={`Status of ${r.name}`} swap="closest tr" />
import type { Child } from "hono/jsx";

/** Tones use only theme tokens, so a badge takes on the app's brand. */
export type Tone = "accent" | "strong" | "neutral" | "muted";
export type StatusOption = { value: string; label: string; tone?: Tone };

// Tinted, not outlined: an outlined badge reads as a button.
const TONES: Record<Tone, string> = {
  accent: "bg-accent/10 text-accent ring-accent/25",
  strong: "bg-panel text-ink ring-line",
  neutral: "bg-panel text-ink-2 ring-transparent",
  muted: "bg-surface text-ink-3 ring-line",
};

/** The submitted status when it is one of the options, otherwise null. */
export function pickStatus(v: unknown, options: StatusOption[]): string | null {
  return typeof v === "string" && options.some((o) => o.value === v) ? v : null;
}

export function StatusBadge({ value, options }: { value: string; options: StatusOption[] }) {
  const o = options.find((x) => x.value === value);
  return (
    <span class={"inline-flex items-center whitespace-nowrap rounded-control px-2 py-0.5 text-label font-semibold ring-1 ring-inset " + TONES[o?.tone ?? "neutral"]}>
      {o?.label ?? value}
    </span>
  );
}

const focus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
/** An input, select or textarea; the same height as a button, so a row of them lines up. */
export const controlClass = `min-h-9 rounded-control border border-line-strong bg-surface px-2.5 py-1.5 text-copy font-normal text-ink shadow-card ${focus}`;
/** Any button, or a link that does an action. */
export const buttonClass = `inline-flex min-h-9 items-center justify-center rounded-control border border-line-strong bg-surface px-3 text-label font-semibold text-ink no-underline shadow-card hover:bg-canvas ${focus}`;
/** The page's one main action. */
export const primaryClass = `inline-flex min-h-9 items-center justify-center rounded-control border border-accent bg-accent px-3 text-label font-semibold text-accent-ink no-underline shadow-card hover:border-accent-hover hover:bg-accent-hover ${focus}`;
/** A label around its control: the words above, the control below. */
export const fieldClass = "flex flex-col gap-1.5 text-label font-semibold text-ink";

export function StatusForm(props: {
  action: string;
  current: string;
  options: StatusOption[];
  /** Where the 303 goes; the route checks it with localPath. */
  returnTo: string;
  /** The select's accessible name, e.g. "Status of Ann Lee". */
  label: string;
  /** An htmx target to replace with the route's answer; omit for a plain form. */
  swap?: string;
  extra?: Child;
}) {
  const { action, current, options, returnTo, label, swap, extra } = props;
  const hx = swap ? { "hx-post": action, "hx-trigger": "change", "hx-target": swap, "hx-swap": "outerHTML", "hx-push-url": "false" } : {};
  const save = <button class={buttonClass}>Save</button>;
  return (
    <form method="post" action={action} class="flex flex-wrap items-center gap-2" {...hx}>
      <input type="hidden" name="return" value={returnTo} />
      <select name="status" aria-label={label} class={controlClass}>
        {options.map((o) => (
          <option value={o.value} selected={o.value === current}>
            {o.label}
          </option>
        ))}
      </select>
      {extra}
      {swap ? <noscript>{save}</noscript> : save}
    </form>
  );
}

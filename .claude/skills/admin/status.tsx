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

const TONES: Record<Tone, string> = {
  accent: "bg-accent text-accent-ink border-accent",
  strong: "bg-surface text-ink border-line-strong",
  neutral: "bg-panel text-ink-2 border-line",
  muted: "bg-canvas text-ink-3 border-line",
};

/** The submitted status when it is one of the options, otherwise null. */
export function pickStatus(v: unknown, options: StatusOption[]): string | null {
  return typeof v === "string" && options.some((o) => o.value === v) ? v : null;
}

export function StatusBadge({ value, options }: { value: string; options: StatusOption[] }) {
  const o = options.find((x) => x.value === value);
  return (
    <span class={"inline-block whitespace-nowrap rounded-control border px-2 text-label " + TONES[o?.tone ?? "neutral"]}>
      {o?.label ?? value}
    </span>
  );
}

export const controlClass =
  "rounded-control border border-line-strong bg-canvas px-2 py-1 text-copy text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
export const buttonClass =
  "rounded-control border border-line-strong bg-surface px-3 py-1 text-label font-semibold text-ink hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

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

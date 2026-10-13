// A status as a badge, and what every private page's controls share: inputs,
// selects and buttons one height, so a row of them lines up, and one small
// type for the sentences around them.
import type { Child } from "hono/jsx";

/** Tones use only theme tokens, so a badge takes on the app's brand. */
export type Tone = "accent" | "strong" | "neutral" | "muted" | "late";
export type StatusOption = { value: string; label: string; tone?: Tone };

// Tinted, not outlined: an outlined badge reads as a button.
const TONES: Record<Tone, string> = {
  accent: "bg-accent/10 text-accent ring-accent/25",
  strong: "bg-panel text-ink ring-line",
  neutral: "bg-panel text-ink-2 ring-transparent",
  muted: "bg-surface text-ink-3 ring-line",
  // Past its day (an invoice past due): the app's --color-late, where it has one.
  late: "bg-late/10 text-late ring-late/25",
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

// The controls follow Tailwind's own form components (Tailwind Plus): a 1px
// outline that turns into a 2px accent one on focus, 16px text on a phone
// (so iOS does not zoom) and 14px from sm up, and buttons at 14px semibold.
// An input (py-1.5, 24px line) and a button (py-2, 20px line) come out the
// same 36px, so a row of them lines up without fixing a height.
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
/** The look of a text input, textarea or bare select; its width is where it sits (inputClass fills it). */
export const controlClass =
  "rounded-control bg-surface px-3 py-1.5 text-base text-ink outline-1 -outline-offset-1 outline-line-strong placeholder:text-ink-3 focus:outline-2 focus:-outline-offset-2 focus:outline-accent aria-invalid:outline-2 aria-invalid:-outline-offset-2 aria-invalid:outline-ink sm:text-sm/6";
/** A text input or a textarea that fills where it sits. A select is <Select>. */
export const inputClass = `block w-full ${controlClass}`;
/** Any button, or a link that does an action. */
export const buttonClass = `inline-flex shrink-0 items-center justify-center gap-x-1.5 rounded-control bg-surface px-3 py-2 text-sm font-semibold text-ink no-underline inset-ring inset-ring-line-strong hover:bg-panel/60 ${focusRing}`;
/** The page's one main action. */
export const primaryClass = `inline-flex shrink-0 items-center justify-center gap-x-1.5 rounded-control bg-accent px-3 py-2 text-sm font-semibold text-accent-ink no-underline hover:bg-accent-hover ${focusRing}`;
/** A label around its control: the words above, the control below. */
export const fieldClass = "flex flex-col gap-2 text-sm/6 font-medium text-ink";

/** A link in running text: the site's styles leave links plain, so a private page marks its own. */
export const linkClass = "font-semibold text-accent no-underline hover:underline";

/** Small type for a sentence (a hint, a footnote, a line under a name), as a field's own words are: 14px, regular weight. */
export const smallText = "text-sm/6 font-normal";

/**
 * A select as Tailwind's components draw one: the native arrow off, an icon
 * in its place on the same grid cell, so it is the same in every browser and
 * the same height as an input. `class` sizes the box ("w-full", "w-32");
 * every other attribute goes to the select.
 */
export function Select(props: Record<string, unknown> & { class?: string; children?: Child }) {
  const { class: box = "", children, ...attrs } = props;
  return (
    <span class={"grid grid-cols-1 " + box}>
      <select {...attrs}
        class="col-start-1 row-start-1 w-full appearance-none rounded-control bg-surface py-1.5 pr-8 pl-3 text-base text-ink outline-1 -outline-offset-1 outline-line-strong focus:outline-2 focus:-outline-offset-2 focus:outline-accent aria-invalid:outline-2 aria-invalid:-outline-offset-2 aria-invalid:outline-ink sm:text-sm/6">
        {children}
      </select>
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end text-ink-3 sm:size-4">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" />
      </svg>
    </span>
  );
}

/**
 * A status changed with a form: a plain POST the route answers with a 303;
 * with `swap` set it also posts through htmx on change and the route answers
 * with the updated element (`swap="closest tr"` in a list row), the Save
 * button then in <noscript>, so a row stays one line with JavaScript.
 */
export function StatusForm(props: { action: string; current: string; options: StatusOption[]; returnTo: string; label: string; swap?: string; extra?: Child }) {
  const { action, current, options, returnTo, label, swap, extra } = props;
  const hx = swap ? { "hx-post": action, "hx-trigger": "change", "hx-target": swap, "hx-swap": "outerHTML", "hx-push-url": "false" } : {};
  const save = <button class={buttonClass}>Save</button>;
  return (
    <form method="post" action={action} class="flex flex-wrap items-center gap-2" {...hx}>
      <input type="hidden" name="return" value={returnTo} />
      <Select name="status" aria-label={label}>
        {options.map((o) => <option value={o.value} selected={o.value === current}>{o.label}</option>)}
      </Select>
      {extra}
      {swap ? <noscript>{save}</noscript> : save}
    </form>
  );
}


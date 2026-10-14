// One record: its fields and the free-form JSON a form or webhook left on it.
// Everything stored here came from a visitor, so it is rendered as text, never as HTML
// and never as a link (a stored "javascript:" URL is one click from running).
//
//   <Section title="Details"><FieldList fields={[{ label: "Email", value: r.email }]} /></Section>
//   <Section title="Answers"><JsonData data={r.data} /></Section>
import type { Child } from "hono/jsx";

export type Field = { label: string; value: Child };

/** A card on a record page; `count`, when given and not 0, is how many it lists, in a pill beside the heading. */
export function Section({ title, count, children, class: extra = "" }: { title: string; count?: number; children?: Child; class?: string }) {
  return (
    <section class={"rounded-card border border-line bg-surface p-4 shadow-card " + extra}>
      <h2 class="mb-3 flex items-center gap-2 text-base/7 font-semibold text-ink">
        {title}
        {count ? <span class="rounded-full bg-panel px-2 text-label font-medium tabular-nums text-ink-2">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

/** Label and value pairs; one with no value is left out rather than shown as "None". */
export function FieldList({ fields }: { fields: Field[] }) {
  return (
    <dl class="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[minmax(8rem,auto)_1fr]">
      {fields.filter((f) => f.value !== null && f.value !== undefined && f.value !== "").map((f) => (
        <>
          <dt class="text-label text-ink-3">{f.label}</dt>
          <dd class="min-w-0 break-words">{f.value}</dd>
        </>
      ))}
    </dl>
  );
}

/** A JSON value as nested definition lists, readable and escaped. */
export function JsonData({ data, empty = "Nothing else was sent." }: { data: unknown; empty?: string }) {
  if (data === null || data === undefined || (typeof data === "object" && Object.keys(data as object).length === 0)) {
    return <p class="text-ink-3">{empty}</p>;
  }
  return <>{value(data, 0)}</>;
}

function value(v: unknown, depth: number): Child {
  if (v === null || v === undefined || v === "") return <span class="text-ink-3">None</span>;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string") return <span class="whitespace-pre-wrap break-words">{v}</span>;
  if (typeof v !== "object") return String(v);
  if (depth >= 4) return <pre class="whitespace-pre-wrap break-words text-label">{JSON.stringify(v, null, 2)}</pre>;
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== "object")) return <span class="break-words">{v.map((x) => (x === null ? "" : String(x))).join(", ")}</span>;
    return (
      <ol class="flex flex-col gap-2">
        {v.map((x) => (
          <li class="border-l-2 border-line pl-3">
            {value(x, depth + 1)}
          </li>
        ))}
      </ol>
    );
  }
  return (
    <dl class={"grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[minmax(8rem,auto)_1fr]" + (depth ? " border-l-2 border-line pl-3" : "")}>
      {Object.entries(v as Record<string, unknown>).map(([k, x]) => (
        <>
          <dt class="text-label text-ink-3 break-words">{k}</dt>
          <dd class="min-w-0">
            {value(x, depth + 1)}
          </dd>
        </>
      ))}
    </dl>
  );
}

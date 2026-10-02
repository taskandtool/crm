// One record: its fields, the free-form JSON a form or webhook left on it,
// and optionally a log of what happened to it with a note box. Everything
// stored here came from a visitor, so it is rendered as text, never as HTML
// and never as a link (a stored "javascript:" URL is one click from running).
//
//   <Section title="Details"><FieldList fields={[{ label: "Email", value: r.email }]} /></Section>
//   <Section title="Answers"><JsonData data={r.data} /></Section>
import type { Child } from "hono/jsx";
import { When } from "./list";
import { buttonClass, controlClass } from "./status";

export type Field = { label: string; value: Child };

export function Section({ title, children, class: extra = "" }: { title: string; children?: Child; class?: string }) {
  return (
    <section class={"rounded-card border border-line bg-surface p-4 " + extra}>
      <h2 class="mb-3 text-label font-semibold text-ink-2">{title}</h2>
      {children}
    </section>
  );
}

export function FieldList({ fields }: { fields: Field[] }) {
  return (
    <dl class="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[minmax(8rem,auto)_1fr]">
      {fields.map((f) => (
        <>
          <dt class="text-label text-ink-3">{f.label}</dt>
          <dd class="min-w-0 break-words">{f.value === null || f.value === undefined || f.value === "" ? <span class="text-ink-3">None</span> : f.value}</dd>
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

export type ActivityEntry = { at: Date | string; by?: string | null; text: string };

/** What happened to the record, newest first, and a note box that posts `text`. */
export function Activity(props: {
  entries: ActivityEntry[];
  timeZone: string;
  note?: { action: string; returnTo: string };
}) {
  const { entries, timeZone, note } = props;
  return (
    <div class="flex flex-col gap-3">
      {note ? (
        <form method="post" action={note.action} class="flex flex-col gap-2">
          <input type="hidden" name="return" value={note.returnTo} />
          <label class="flex flex-col gap-1 text-label text-ink-2">
            Add a note
            <textarea name="text" rows={3} maxlength={4000} required class={controlClass}></textarea>
          </label>
          <button class={buttonClass + " self-start"}>Add note</button>
        </form>
      ) : null}
      {entries.length ? (
        <ol class="flex flex-col gap-3">
          {entries.map((e) => (
            <li class="border-l-2 border-line pl-3">
              <p class="text-label text-ink-3">
                <When at={e.at} timeZone={timeZone} />
                {e.by ? ` · ${e.by}` : ""}
              </p>
              <p class="whitespace-pre-wrap break-words">{e.text}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p class="text-ink-3">Nothing yet.</p>
      )}
    </div>
  );
}

// The box a note is written in, the same on every app's page for a person:
// a note, or a call, email, meeting or text, now or at another time. It posts
// `body`, `kind` and `at`; the route reads them into addNote (notes.ts).
import { buttonClass, inputClass, Select } from "../admin/status";
import { NOTE_KINDS, NOTE_LABELS } from "./notes";

export function NoteForm({ action }: { action: string }) {
  return (
    <form method="post" action={action} aria-label="Log activity" class="flex flex-col gap-2">
      <textarea name="body" rows={2} required maxlength={10000} placeholder="Add a note, or log a call" aria-label="Note" class={inputClass}></textarea>
      <div class="flex flex-wrap items-center gap-2">
        <Select name="kind" aria-label="Type" class="w-32">
          {NOTE_KINDS.map((k) => (
            <option value={k}>{NOTE_LABELS[k]}</option>
          ))}
        </Select>
        <button class={buttonClass}>Log activity</button>
        {/* Now, unless it happened earlier: the time is there when it is needed. */}
        <details class="open:basis-full">
          <summary class="w-fit cursor-pointer list-none px-1 text-sm/6 font-semibold text-ink-2 no-underline hover:text-ink">Another time</summary>
          <input name="at" type="datetime-local" aria-label="When it happened" class={inputClass + " mt-2"} />
        </details>
      </div>
    </form>
  );
}

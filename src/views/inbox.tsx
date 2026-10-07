// What came in: one row per submission, booking or payment, newest first,
// each with the person and either their customer or "Add as customer".
// Rows are a list rather than a table so they wrap on a phone.
import { Flash } from "../admin/flash";
import { When } from "../admin/list";
import { StatusBadge, type StatusOption } from "../admin/status";
import { vocab } from "../config";
import { sourceOf, type InboxRow } from "../crm/inbox";
import { money } from "../crm/text";
import { Layout } from "./layout";
import { buttonClass, controlClass, linkButtonClass, MESSAGES, primaryClass, timeZone } from "./ui";

const SUBMISSION: StatusOption[] = [
  { value: "new", label: "New", tone: "accent" },
  { value: "read", label: "Read", tone: "strong" },
  { value: "done", label: "Done", tone: "muted" },
];
const BOOKING: StatusOption[] = [
  { value: "confirmed", label: "Confirmed", tone: "strong" },
  { value: "cancelled", label: "Cancelled", tone: "muted" },
  { value: "completed", label: "Completed", tone: "neutral" },
  { value: "no_show", label: "No show", tone: "muted" },
];
const PAYMENT: StatusOption[] = [
  { value: "paid", label: "Paid", tone: "strong" },
  { value: "refunded", label: "Refunded", tone: "muted" },
  { value: "partially_refunded", label: "Partly refunded", tone: "neutral" },
];

export type InboxProps = {
  user: string;
  rows: InboxRow[];
  next: string | null;
  more: (cursor: string) => string;
  self: string;
  unmatched: boolean;
  /** The form chosen, and the forms to choose from. */
  form: string | null;
  forms: { key: string; title: string }[];
  paged: boolean;
  missing: string | null;
  flash: { code?: string | null; n?: string | null };
};

export function InboxPage(p: InboxProps) {
  return (
    <Layout title="What came in" user={p.user} section="inbox">
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      {/* The box applies on change (htmx swaps #results and pushes the URL,
          so back and refresh keep it); Apply is the same form without JS. */}
      <form method="get" action="/" hx-get="/" hx-target="#results" hx-swap="outerHTML" hx-push-url="true" class="mb-4 flex flex-wrap items-center gap-3 text-label text-ink-2">
        {p.forms.length ? (
          <label class="flex items-center gap-2">
            From
            <select name="form" hx-get="/" hx-trigger="change" hx-include="closest form" class={controlClass}>
              <option value="">Everything</option>
              {p.forms.map((f) => <option value={f.key} selected={f.key === p.form}>{f.title}</option>)}
            </select>
          </label>
        ) : null}
        <label class="flex items-center gap-2">
          <input type="checkbox" name="unmatched" value="1" checked={p.unmatched} hx-get="/" hx-trigger="change" hx-include="closest form" />
          Only people who are not {vocab.many.toLowerCase()} yet
        </label>
        <button class={buttonClass}>Apply</button>
      </form>
      <InboxResults {...p} />
    </Layout>
  );
}

/** Everything under the filter. Also the htmx answer to the filter. */
export function InboxResults(p: Pick<InboxProps, "rows" | "next" | "more" | "self" | "unmatched" | "paged" | "missing">) {
  return (
    <div id="results">
      {p.missing && p.rows.length ? <p class="mb-4 text-label text-ink-3">{p.missing}</p> : null}
      {p.paged ? (
        <p class="mb-3 text-label">
          <a href={p.self}>Back to the newest</a>
        </p>
      ) : null}
      {p.rows.length ? (
        <ol id="inbox" class="flex flex-col overflow-hidden rounded-card border border-line bg-surface">
          <InboxRows rows={p.rows} next={p.next} more={p.more} self={p.self} />
        </ol>
      ) : (
        <div class="rounded-card border border-line bg-surface px-4 py-8 text-center text-ink-2">
          {p.unmatched ? (
            <p>Everyone who got in touch is already a {vocab.one.toLowerCase()}.</p>
          ) : (
            <>
              <p class="font-semibold text-ink">Nothing has come in yet.</p>
              <p class="mx-auto mt-1 max-w-xl">
                {p.missing ?? "Form submissions, bookings and payments from the project's other apps show here as they arrive."}
              </p>
              <p class="mx-auto mt-3 max-w-xl">
                Meanwhile, <a href="/customers#new-customer">add a {vocab.one.toLowerCase()} by hand</a>, or ask the AI in chat to import the list you keep today.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The rows, then Load more. Also the htmx answer to Load more. */
export function InboxRows({ rows, next, more, self }: { rows: InboxRow[]; next: string | null; more: (cursor: string) => string; self: string }) {
  return (
    <>
      {rows.map((r) => (
        <Row row={r} self={self} />
      ))}
      {next ? (
        <li class="px-4 py-3 text-center">
          <a href={more(next)} hx-get={more(next)} hx-target="closest li" hx-swap="outerHTML" hx-push-url="false" class={linkButtonClass}>
            Load more
          </a>
        </li>
      ) : null}
    </>
  );
}

function Row({ row, self }: { row: InboxRow; self: string }) {
  const person = row.name || row.email || row.phone || "Someone";
  return (
    <li id={`${row.kind}-${row.id}`} class="flex flex-col gap-2 border-b border-line px-4 py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4">
      <div class="min-w-0 flex-1">
        <p class="flex flex-wrap items-center gap-x-2 text-label text-ink-3">
          <span class="font-semibold text-ink-2">{sourceOf(row)}</span>
          <When at={row.created_at} timeZone={timeZone} />
          <Status row={row} />
        </p>
        <p class="mt-1 break-words">
          <span class="font-semibold">{person}</span>
          {row.email && row.email !== person ? <span class="text-ink-2"> · {row.email}</span> : null}
          {row.phone && row.phone !== person ? <span class="text-ink-2"> · <span class="whitespace-nowrap">{row.phone}</span></span> : null}
        </p>
        <What row={row} />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        {row.customer_id ? (
          <a href={`/customers/${row.customer_id}`} class={buttonClass + " no-underline"}>
            Open {row.customer_name}
            {row.customer_archived_at ? " (archived)" : ""}
          </a>
        ) : (
          <form method="post" action="/inbox/add">
            <input type="hidden" name="kind" value={row.kind} />
            <input type="hidden" name="id" value={row.id} />
            <button class={primaryClass} aria-label={`Add ${person} as a ${vocab.one.toLowerCase()}`}>
              Add as {vocab.one.toLowerCase()}
            </button>
          </form>
        )}
        {row.kind === "submission" && (row.status === "new" || row.status === "read") ? (
          <form method="post" action="/inbox/done">
            <input type="hidden" name="id" value={row.id} />
            <input type="hidden" name="return" value={self} />
            <button class={buttonClass} aria-label={`Mark ${person}'s ${sourceOf(row)} done`}>
              Mark done
            </button>
          </form>
        ) : null}
      </div>
    </li>
  );
}

function Status({ row }: { row: InboxRow }) {
  const options = row.kind === "submission" ? SUBMISSION : row.kind === "booking" ? BOOKING : PAYMENT;
  return <StatusBadge value={row.status} options={options} />;
}

/** One line of what it was: the message, the booked time, the amount. */
function What({ row }: { row: InboxRow }) {
  if (row.kind === "submission") {
    const text = firstText(row.data);
    return text ? <p class="mt-1 line-clamp-2 break-words text-ink-2">{text}</p> : null;
  }
  if (row.kind === "booking") {
    return (
      <p class="mt-1 text-ink-2">
        {row.type_name ?? "Booked"}, <When at={row.starts_at} timeZone={timeZone} />
        {row.resource_name ? ` with ${row.resource_name}` : ""}
      </p>
    );
  }
  return (
    <p class="mt-1 text-ink-2">
      {money(row.amount_cents, row.currency)}
      {row.pay_kind !== "full" ? ` ${row.pay_kind}` : ""}
      {row.description ? `, ${row.description}` : ""}
      {row.livemode === false ? " (test mode)" : ""}
    </p>
  );
}

/** The first answer worth reading: a message if there is one, else the first text. */
export function firstText(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  const entries = Object.entries(data).filter(([k, v]) => !k.startsWith("_") && typeof v === "string" && v.trim());
  const msg = entries.find(([k]) => /message|comment|note|details|question|enquiry|inquiry|about|reason|issue|problem|describe/i.test(k)) ?? entries[0];
  return msg ? String(msg[1]).slice(0, 300) : null;
}

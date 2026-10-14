// The Inbox: four figures (new leads this week, tasks due, open deals,
// won this month), then To do (or Everything): one row per submission,
// booking or payment, newest first; a click on it opens it, the person's
// name opens them once they are a customer, "Add as customer" while they are not, and
// "Add as deal" (a repeat customer's new enquiry too). Rows are a list
// rather than a table so they wrap on a phone.
import { Flash } from "../admin/flash";
import { EmptyCard, rowClick, When } from "../admin/list";
import { listUrl } from "../admin/query";
import { StatusBadge, type StatusOption } from "../admin/status";
import { BOOKING_STATUSES } from "../booking/admin";
import { dealsCfg, eventsCfg, invoicesCfg, vocab } from "../config";
import type { Overview } from "../crm/overview";
import { sourceOf, type InboxRow } from "../crm/inbox";
import { formatWholeMoney } from "../crm/text";
import { STATUSES as SUBMISSION_STATUSES } from "../forms/admin";
import { STATUSES as PAYMENT_STATUSES } from "../payments/admin";
import { formatMoney } from "../payments/money";
import { Layout } from "./layout";
import { buttonClass, controlClass, MESSAGES, timeZone, ViewLink } from "./ui";

// Each kind's own labels, as its page shows them; in the Inbox only New stands out.
const quiet = (list: StatusOption[]): StatusOption[] => list.map((o) => (o.value !== "new" && o.tone === "accent" ? { ...o, tone: "strong" } : o));
const SUBMISSION = quiet(SUBMISSION_STATUSES), BOOKING = quiet(BOOKING_STATUSES), PAYMENT = quiet(PAYMENT_STATUSES);

export type InboxProps = {
  user: string;
  rows: InboxRow[];
  next: string | null;
  more: (cursor: string) => string;
  self: string;
  /** Everything, rather than To do. */
  all: boolean;
  /** The form chosen, and the forms to choose from. */
  form: string | null;
  forms: { key: string; title: string }[];
  paged: boolean;
  missing: string | null;
  numbers: Overview;
  flash: { code?: string | null; n?: string | null };
};

/** The four figures, each a link to the list behind it. */
function Numbers({ n }: { n: Overview }) {
  const due = n.due.overdue + n.due.today;
  const figure = (href: string, value: string, label: string, sub: string | null) => (
    <a href={href} class="flex min-w-0 flex-col rounded-card border border-line bg-surface shadow-card px-4 py-3 no-underline hover:border-line-strong">
      <span class="text-title font-semibold text-ink">{value}</span>
      <span class="text-label text-ink-2">{label}</span>
      {sub ? <span class="text-label text-ink-3">{sub}</span> : null}
    </a>
  );
  const whole = (cents: string) => formatWholeMoney(cents, dealsCfg.currency);
  return (
    <div class="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {figure("#results", n.leads ? String(n.leads.current) : "None yet", "New leads, 7 days", n.leads ? `${n.leads.previous} the week before` : "No forms on the project yet")}
      {figure("/tasks", String(due), "Your tasks due", n.due.overdue ? `${n.due.overdue} overdue` : due ? "All today" : "Nothing overdue")}
      {figure("/deals", whole(n.open.cents), `Open ${dealsCfg.many.toLowerCase()}`, n.open.count === 1 ? `1 ${dealsCfg.one.toLowerCase()}` : `${n.open.count} ${dealsCfg.many.toLowerCase()}`)}
      {figure("/deals", whole(n.won.cents), "Won this month", n.won.count === 1 ? `1 ${dealsCfg.one.toLowerCase()}` : `${n.won.count} ${dealsCfg.many.toLowerCase()}`)}
    </div>
  );
}

export function InboxPage(p: InboxProps) {
  return (
    <Layout title="Inbox" user={p.user} section="inbox">
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <Numbers n={p.numbers} />
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3 text-label">
        <nav aria-label="Which" class="flex gap-1">
          {[["To do", false], ["Everything", true]].map(([label, all]) => (
            <ViewLink href={listUrl("/", { view: all ? "all" : null, form: p.form })} on={p.all === all}>{label}</ViewLink>
          ))}
        </nav>
        {/* Applies on change (htmx swaps #results and pushes the URL); the button is for a browser without JavaScript. */}
        {p.forms.length ? (
          <form method="get" action="/" hx-get="/" hx-target="#results" hx-swap="outerHTML" hx-push-url="true" class="flex items-center gap-2">
            {p.all ? <input type="hidden" name="view" value="all" /> : null}
            <label>
              <span class="sr-only">Source</span>
              <select name="form" hx-get="/" hx-trigger="change" hx-include="closest form" class={controlClass}>
                <option value="">All sources</option>
                {p.forms.map((f) => <option value={f.key} selected={f.key === p.form}>{f.title}</option>)}
              </select>
            </label>
            <noscript><button class={buttonClass}>Apply</button></noscript>
          </form>
        ) : null}
      </div>
      <InboxResults {...p} />
    </Layout>
  );
}

/** Everything under the filter. Also the htmx answer to the filter. */
export function InboxResults(p: Pick<InboxProps, "rows" | "next" | "more" | "self" | "all" | "form" | "paged" | "missing">) {
  return (
    <div id="results">
      {p.missing && p.rows.length ? <p class="mb-4 text-label text-ink-3">{p.missing}</p> : null}
      {p.paged ? (
        <p class="mb-3 text-label">
          <a href={p.self}>Back to the newest</a>
        </p>
      ) : null}
      {p.rows.length ? (
        <ol id="inbox" class="flex flex-col overflow-hidden rounded-card border border-line bg-surface shadow-card">
          <InboxRows rows={p.rows} next={p.next} more={p.more} self={p.self} />
        </ol>
      ) : (
        !p.all ? (
          <EmptyCard title="All caught up." action={<a href={listUrl("/", { view: "all", form: p.form })} class={buttonClass}>See everything that came in</a>}>
            New form requests, and bookings and payments from people who are not {vocab.many.toLowerCase()} yet, land here.
          </EmptyCard>
        ) : (
          <EmptyCard title="No leads yet." action={<a href="/customers/new" class={buttonClass}>Add {vocab.one.toLowerCase()}</a>}>
            {p.missing ?? "Form submissions, bookings and payments from your other apps show up here."}
          </EmptyCard>
        )
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
          <a href={more(next)} hx-get={more(next)} hx-target="closest li" hx-swap="outerHTML" hx-push-url="false" class={buttonClass}>
            Load more
          </a>
        </li>
      ) : null}
    </>
  );
}

/** Where the thing that came in is kept: the submission, the booking, the payment (when this CRM shows that page). */
function itemHref(row: InboxRow): string | null {
  if (row.kind === "submission") return `/forms/submissions/${row.id}`;
  if (row.kind === "booking") return eventsCfg ? `/events/${row.id}` : null;
  return invoicesCfg ? `/invoices/payments/${row.id}` : null;
}

// As HubSpot's and Pipedrive's inboxes (and Gmail): a click on a row opens
// what came in; the person's name opens the customer, the buttons act.
function Row({ row, self }: { row: InboxRow; self: string }) {
  const person = row.name || row.email || row.phone || "Someone";
  const href = itemHref(row);
  return (
    <li id={`${row.kind}-${row.id}`} {...(href ? rowClick(href) : {})}
      class={"flex flex-col gap-2 border-b border-line px-4 py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4" + (href ? " cursor-pointer hover:bg-canvas" : "")}>
      <div class="min-w-0 flex-1">
        <p class="flex flex-wrap items-center gap-x-2 text-label text-ink-3">
          {href ? <a href={href} class="font-semibold text-ink-2 no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{sourceOf(row)}</a> : <span class="font-semibold text-ink-2">{sourceOf(row)}</span>}
          <When at={row.created_at} timeZone={timeZone} />
          <Status row={row} />
        </p>
        <p class="mt-1 break-words">
          {/* A customer already: their name (as the record has it) opens them. */}
          {row.customer_id ? (
            <a href={`/customers/${row.customer_id}`} class="font-semibold no-underline hover:underline">
              {row.customer_name ?? person}{row.customer_archived_at ? " (archived)" : ""}
            </a>
          ) : (
            <span class="font-semibold">{person}</span>
          )}
          {row.email && row.email !== person ? <span class="text-ink-2"> · {row.email}</span> : null}
          {row.phone && row.phone !== person ? <span class="text-ink-2"> · <span class="whitespace-nowrap">{row.phone}</span></span> : null}
        </p>
        <What row={row} />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        {row.customer_id ? null : (
          <form method="post" action="/inbox/add">
            <input type="hidden" name="kind" value={row.kind} />
            <input type="hidden" name="id" value={row.id} />
            <button class={buttonClass} aria-label={`Add ${person} as a ${vocab.one.toLowerCase()}`}>
              Add as {vocab.one.toLowerCase()}
            </button>
          </form>
        )}
        <form method="post" action="/inbox/deal">
          <input type="hidden" name="kind" value={row.kind} />
          <input type="hidden" name="id" value={row.id} />
          <button class={buttonClass} aria-label={`Add a ${dealsCfg.one.toLowerCase()} for ${person}`}>
            Add as {dealsCfg.one.toLowerCase()}
          </button>
        </form>
        {/* What still needs someone can be marked done: a form by its status, a booking or payment nobody made a customer of. */}
        {(row.kind === "submission" ? row.status === "new" || row.status === "read" : !row.customer_id && !row.handled && row.status !== "cancelled") ? (
          <form method="post" action="/inbox/done">
            <input type="hidden" name="kind" value={row.kind} />
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
      {formatMoney(row.amount_cents, row.currency)}
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

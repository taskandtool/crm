// The Inbox: four figures (new leads this week, tasks due, open deals,
// won this month), then To do (or Everything): one row per submission,
// booking or payment, newest first; a click on it opens it, the person's
// name opens their customer record, New deal makes a deal of it (a repeat
// customer's new enquiry too) and Done clears it. Rows are a list rather
// than a table so they wrap on a phone.
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
import { Avatar, buttonClass, controlClass, MESSAGES, quietClass, timeZone, ViewLink, viewsClass } from "./ui";

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

/**
 * The four figures, each a link to the list behind it, as Catalyst's and
 * Stripe's dashboards have them: no boxes, a rule above, the label, the
 * figure large, then one line of context with a chip where it moved.
 */
function Numbers({ n }: { n: Overview }) {
  const due = n.due.overdue + n.due.today;
  const figure = (href: string, label: string, value: string, sub: string | null, chip?: { text: string; tone: "good" | "late" | "neutral" }) => (
    <a href={href} class="group flex min-w-0 flex-col border-t border-line pt-4 no-underline">
      <span class="font-medium text-ink-2 group-hover:text-ink">{label}</span>
      <span class="mt-2 text-display font-semibold tabular-nums text-ink">{value}</span>
      <span class="mt-2 flex flex-wrap items-center gap-2 text-label text-ink-3">
        {chip ? <span class={"rounded-control px-1.5 py-0.5 font-medium tabular-nums " + CHIP[chip.tone]}>{chip.text}</span> : null}
        {sub}
      </span>
    </a>
  );
  const whole = (cents: string) => formatWholeMoney(cents, dealsCfg.currency);
  const count = (k: number) => (k === 1 ? `1 ${dealsCfg.one.toLowerCase()}` : `${k} ${dealsCfg.many.toLowerCase()}`);
  const moved = n.leads ? n.leads.current - n.leads.previous : 0;
  return (
    <div class="mb-12 grid grid-cols-2 gap-x-8 gap-y-6 lg:grid-cols-4">
      {n.leads
        ? figure("#results", "New leads, 7 days", String(n.leads.current), `${n.leads.previous} the week before`,
            moved ? { text: (moved > 0 ? "+" : "") + moved, tone: moved > 0 ? "good" : "neutral" } : undefined)
        : figure("#results", "New leads, 7 days", "None yet", "No forms on the project yet")}
      {figure("/tasks", "Your tasks due", String(due), n.due.overdue ? null : due ? "All today" : "Nothing overdue",
        n.due.overdue ? { text: `${n.due.overdue} overdue`, tone: "late" } : undefined)}
      {figure("/deals", `Open ${dealsCfg.many.toLowerCase()}`, whole(n.open.cents), count(n.open.count))}
      {figure("/deals", "Won this month", whole(n.won.cents), count(n.won.count))}
    </div>
  );
}

const CHIP = { good: "bg-good/10 text-good", late: "bg-late/10 text-late", neutral: "bg-panel text-ink-2" };

export function InboxPage(p: InboxProps) {
  return (
    <Layout title="Inbox" user={p.user} section="inbox">
      <Flash code={p.flash.code} n={p.flash.n} messages={MESSAGES} />
      <Numbers n={p.numbers} />
      <div class="mb-2 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Which" class={viewsClass}>
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
        <ol id="inbox" class="flex flex-col border-t border-line">
          <InboxRows rows={p.rows} next={p.next} more={p.more} self={p.self} />
        </ol>
      ) : (
        !p.all ? (
          <EmptyCard title="All caught up." action={<a href={listUrl("/", { view: "all", form: p.form })} class={buttonClass}>See everything that came in</a>}>
            New form requests and online bookings land here until someone marks them done or makes a {dealsCfg.one.toLowerCase()} of them.
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
        <li class="py-4 text-center">
          <a href={more(next)} hx-get={more(next)} hx-target="closest li" hx-swap="outerHTML" hx-push-url="false" class={buttonClass}>
            Load more
          </a>
        </li>
      ) : null}
    </>
  );
}

/** Where the thing that came in is kept: the submission, the booking (a change's too), the quote, the payment (when this CRM shows that page). */
function itemHref(row: InboxRow): string | null {
  if (row.kind === "submission") return `/forms/submissions/${row.id}`;
  if (row.kind === "booking") return eventsCfg ? `/events/${row.id}` : null;
  if (row.kind === "change") return eventsCfg ? `/events/${row.booking_id}` : null;
  if (row.kind === "quote") return invoicesCfg ? `/invoices/quotes/${row.id}` : null;
  return invoicesCfg ? `/invoices/payments/${row.id}` : null;
}

// As Pipedrive's Leads Inbox and Jobber's requests: a click on a row opens
// what came in and the person's name opens their customer record (everyone
// who gets in touch is one, saved as they do). Two actions, both in
// view: New deal, and Done for what still needs someone, so the To do list
// can be cleared without opening anything. A booker's change or a quote they
// accepted is news about work already in hand: Done only.
function Row({ row, self }: { row: InboxRow; self: string }) {
  const person = row.name || row.email || row.phone || "Someone";
  const href = itemHref(row);
  const hidden = (
    <>
      <input type="hidden" name="kind" value={row.kind} />
      <input type="hidden" name="id" value={row.id} />
    </>
  );
  // What still needs someone: a form request by its status; an online booking, a booker's change or an online yes nobody has marked done.
  const open = row.kind === "submission" ? row.status === "new" || row.status === "read"
    : row.kind === "booking" ? !row.handled && row.status !== "cancelled"
    : row.kind === "change" || row.kind === "quote" ? !row.handled
    : false;
  const enquiry = row.kind === "submission" || row.kind === "booking" || row.kind === "payment";
  const deal = dealsCfg.one.toLowerCase();
  return (
    <li id={`${row.kind}-${row.id}`} {...(href ? rowClick(href) : {})}
      class={"flex flex-col gap-3 border-b border-line py-4 sm:flex-row sm:items-start sm:gap-4" + (href ? " cursor-pointer hover:bg-canvas/60" : "")}>
      <div class="flex min-w-0 flex-1 gap-3">
        <Avatar name={row.customer_name ?? person} />
        <div class="min-w-0 flex-1">
          <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
            {row.customer_id ? (
              <a href={`/customers/${row.customer_id}`} class="font-medium text-ink no-underline hover:underline">
                {row.customer_name ?? person}{row.customer_archived_at ? " (archived)" : ""}
              </a>
            ) : (
              <span class="font-medium text-ink">{person}</span>
            )}
            <Status row={row} />
          </p>
          <p class="mt-0.5 flex flex-wrap gap-x-1.5 text-label text-ink-3">
            {href ? <a href={href} class="font-medium text-ink-2 no-underline hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{sourceOf(row)}</a> : <span class="font-medium text-ink-2">{sourceOf(row)}</span>}
            <span aria-hidden="true">·</span>
            <When at={row.created_at} timeZone={timeZone} />
            {row.email && row.email !== person ? <><span aria-hidden="true">·</span><span class="break-all">{row.email}</span></> : null}
            {row.phone && row.phone !== person ? <><span aria-hidden="true">·</span><span class="whitespace-nowrap">{row.phone}</span></> : null}
          </p>
          <What row={row} />
        </div>
      </div>
      <div class="flex items-center gap-2 pl-11 sm:pl-0">
        {enquiry ? (
          <form method="post" action="/inbox/deal">
            {hidden}
            <button class={buttonClass} aria-label={`New ${deal} for ${person}`}>New {deal}</button>
          </form>
        ) : null}
        {open ? (
          <form method="post" action="/inbox/done">
            {hidden}
            <input type="hidden" name="return" value={self} />
            <button class={quietClass} aria-label={`Mark ${person}'s ${sourceOf(row)} done`}>Done</button>
          </form>
        ) : null}
      </div>
    </li>
  );
}

// A booker's change says what they did; a quote's yes is the accent, as a won stage is.
const CHANGE: StatusOption[] = [{ value: "rescheduled", label: "Rescheduled", tone: "strong" }, { value: "cancelled", label: "Cancelled", tone: "muted" }];
const QUOTE: StatusOption[] = [{ value: "accepted", label: "Accepted", tone: "accent" }];

function Status({ row }: { row: InboxRow }) {
  const options = row.kind === "submission" ? SUBMISSION : row.kind === "booking" ? BOOKING : row.kind === "change" ? CHANGE : row.kind === "quote" ? QUOTE : PAYMENT;
  return <StatusBadge value={row.status} options={options} />;
}

/** One line of what it was: the message, the booked time, the amount. */
function What({ row }: { row: InboxRow }) {
  if (row.kind === "submission") {
    const text = firstText(row.data);
    return text ? <p class="mt-1.5 line-clamp-2 break-words text-ink-2">{text}</p> : null;
  }
  if (row.kind === "booking") {
    return (
      <p class="mt-1.5 text-ink-2">
        {row.type_name ?? "Booked"}, <When at={row.starts_at} timeZone={timeZone} />
        {row.resource_name ? ` with ${row.resource_name}` : ""}
      </p>
    );
  }
  if (row.kind === "change") {
    // In the booker's own words of it: what moved, from when to when, or what they cancelled.
    return (
      <p class="mt-1.5 text-ink-2">
        {row.type_name ?? "Their booking"}
        {row.resource_name ? ` with ${row.resource_name}` : ""}
        {row.starts_at ? <>{" moved from "}<When at={row.was_starts_at} timeZone={timeZone} />{" to "}<When at={row.starts_at} timeZone={timeZone} /></>
          : <>{" on "}<When at={row.was_starts_at} timeZone={timeZone} />{", cancelled by them"}</>}
      </p>
    );
  }
  if (row.kind === "quote") {
    return <p class="mt-1.5 text-ink-2">{formatMoney(row.total_cents, row.currency)}, accepted and paid online</p>;
  }
  return (
    <p class="mt-1.5 text-ink-2">
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

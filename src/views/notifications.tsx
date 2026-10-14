// The bell's page: what happened without the team doing it, newest first,
// what is new since the last look in bold with a dot. Each row opens its
// record; there is nothing to do here but read.
import { EmptyCard, rowClick, When } from "../admin/list";
import { eventsCfg, invoicesCfg } from "../config";
import { isUnread, type Notice } from "../crm/notifications";
import { formatMoney } from "../payments/money";
import { Layout } from "./layout";
import { timeZone } from "./ui";

/** Where it is kept: the event a change moved, the quote, the payment (when this CRM shows those pages). */
function noticeHref(n: Notice): string | null {
  if (n.kind === "change") return eventsCfg ? `/events/${n.booking_id}` : null;
  if (n.kind === "quote") return invoicesCfg ? `/invoices/quotes/${n.id}` : null;
  return invoicesCfg ? `/invoices/payments/${n.id}` : null;
}

/** What happened, in one sentence: who did what. */
function Said({ n }: { n: Notice }) {
  const who = <span class="text-ink">{n.name || n.email || "Someone"}</span>;
  if (n.kind === "change") {
    const what = <span class="text-ink">{n.type_name ?? "their booking"}</span>;
    return n.starts_at
      ? <>{who} moved {what} to <When at={n.starts_at} timeZone={timeZone} /></>
      : <>{who} cancelled {what} on <When at={n.was_starts_at} timeZone={timeZone} /></>;
  }
  if (n.kind === "quote") return <>{who} accepted Quote {n.number} and paid {formatMoney(n.total_cents, n.currency)}</>;
  return (
    <>
      Payment of {formatMoney(n.amount_cents, n.currency)} from {who}
      {n.description ? `, ${n.description}` : ""}
      {n.livemode === false ? " (test mode)" : ""}
    </>
  );
}

export function NotificationsPage({ user, rows, seen }: { user: string; rows: Notice[]; seen: Date | null }) {
  return (
    <Layout title="Notifications" user={user} section="notifications">
      {rows.length ? (
        <ul class="border-t border-line">
          {rows.map((n) => {
            const href = noticeHref(n);
            const fresh = isUnread(n, seen);
            return (
              <li {...(href ? rowClick(href) : {})}
                class={"flex gap-3 border-b border-line py-4" + (href ? " cursor-pointer hover:bg-canvas/60" : "")}>
                <span aria-hidden="true" class={"mt-2 size-2 shrink-0 rounded-full " + (fresh ? "bg-accent" : "")}></span>
                <div class="min-w-0 flex-1">
                  <p class={"break-words " + (fresh ? "font-semibold text-ink" : "text-ink-2")}>
                    {fresh ? <span class="sr-only">Unread: </span> : null}
                    {href ? <a href={href} class="text-inherit no-underline hover:underline"><Said n={n} /></a> : <Said n={n} />}
                  </p>
                  <p class="mt-0.5 text-label text-ink-3"><When at={n.at} timeZone={timeZone} /></p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyCard title="Nothing yet">
          A customer moving or cancelling their own booking, a quote paid online and payments show up here.
        </EmptyCard>
      )}
    </Layout>
  );
}

/** The bell's count: nothing when all is read. */
export function UnreadCount({ n, max }: { n: number; max: number }) {
  if (!n) return <span hidden></span>;
  return (
    <span class="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-label font-semibold tabular-nums text-accent-ink">
      <span class="sr-only">, </span>{n >= max ? `${max}+` : n}<span class="sr-only"> unread</span>
    </span>
  );
}

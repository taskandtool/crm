// The bell's page: what happened without the team doing it, newest first,
// under its day (Today, Yesterday, then each day); who it was first, what is
// new since the last look in bold with a dot. Each row opens its record;
// there is nothing to do here but read.
import { EmptyCard, rowClick, When } from "../admin/list";
import { formatTime } from "../booking/slots";
import { eventsCfg, invoicesCfg } from "../config";
import { isUnread, type Notice } from "../crm/notifications";
import { formatMoney } from "../payments/money";
import { todayIn } from "../reports/sql";
import { Layout } from "./layout";
import { Avatar, dueDayText, timeZone } from "./ui";

/** Where it is kept: the event a change moved, the quote, the payment (when this CRM shows those pages). */
function noticeHref(n: Notice): string | null {
  if (n.kind === "change") return eventsCfg ? `/events/${n.booking_id}` : null;
  if (n.kind === "quote") return invoicesCfg ? `/invoices/quotes/${n.id}` : null;
  if (n.kind === "phone") return `/messages/${n.remote_key}`;
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
  if (n.kind === "phone") {
    if (n.what === "text") return <>{who} texted{n.body ? <>: <span class="text-ink">{n.body.length > 80 ? n.body.slice(0, 80) + "…" : n.body}</span></> : null}</>;
    return n.what === "voicemail" ? <>{who} left a voicemail</> : <>Missed call from {who}</>;
  }
  const word = invoicesCfg?.word ?? "Quote";
  if (n.kind === "quote") {
    return n.answer === "accepted"
      ? <>{who} signed {word} {n.number}, {formatMoney(n.total_cents, n.currency)}</>
      : <>{who} declined {word} {n.number}</>;
  }
  return (
    <>
      Payment of {formatMoney(n.amount_cents, n.currency)} from {who}
      {n.description ? `, ${n.description}` : ""}
      {n.livemode === false ? " (test mode)" : ""}
    </>
  );
}

/** The rows under their day, newest first: Today, Yesterday, then each day, as the Tasks page heads its days. */
function byDay(rows: Notice[], today: string): [string, Notice[]][] {
  const out: [string, Notice[]][] = [];
  for (const n of rows) {
    const heading = dueDayText(todayIn(timeZone, n.at), today);
    const last = out[out.length - 1];
    if (last && last[0] === heading) last[1].push(n);
    else out.push([heading, [n]]);
  }
  return out;
}

export function NotificationsPage({ user, rows, seen }: { user: string; rows: Notice[]; seen: Date | null }) {
  const today = todayIn(timeZone);
  return (
    <Layout title="Notifications" user={user} section="notifications">
      {rows.length ? (
        <div class="flex flex-col gap-6">
          {byDay(rows, today).map(([heading, day]) => (
            <section aria-label={heading}>
              <h2 class="mb-2 text-label font-semibold text-ink-2">{heading}</h2>
              <ul class="flex flex-col divide-y divide-line rounded-card bg-surface shadow-card ring-1 ring-line">
                {day.map((n) => {
                  const href = noticeHref(n);
                  const fresh = isUnread(n, seen);
                  return (
                    // Who it was first, as Pipedrive's notifications; new ones carry a dot and bold words.
                    <li {...(href ? rowClick(href) : {})}
                      class={"flex items-center gap-3 px-4 py-3" + (href ? " cursor-pointer hover:bg-canvas/60" : "")}>
                      <Avatar name={n.name || n.email || "?"} />
                      <p class={"min-w-0 flex-1 break-words " + (fresh ? "font-semibold text-ink" : "text-ink-2")}>
                        {fresh ? <span class="sr-only">Unread: </span> : null}
                        {href ? <a href={href} class="text-inherit no-underline hover:underline"><Said n={n} /></a> : <Said n={n} />}
                      </p>
                      <span class="shrink-0 text-label tabular-nums text-ink-3">{formatTime(n.at, timeZone)}</span>
                      <span aria-hidden="true" class={"size-2 shrink-0 rounded-full " + (fresh ? "bg-accent" : "")}></span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <EmptyCard title="Nothing yet">
          A customer moving or cancelling their own booking, signing or declining a {(invoicesCfg?.word ?? "Quote").toLowerCase()} at its link, and payments show up here.
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

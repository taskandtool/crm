// Home, the first screen, as Jobber's Home: a greeting, the figures in one
// card of cells sharing 1px rules (Tailwind's stats block; each a link to the
// list behind it), then four short lists, each a card with its count and the
// way to the whole list, in two columns that stack on their own: new leads
// and your tasks due, today and closing this month. No charts here.
import type { Child } from "hono/jsx";
import { Flash } from "../admin/flash";
import { When } from "../admin/list";
import { listUrl } from "../admin/query";
import { formatTime } from "../booking/slots";
import { dealsCfg, eventsCfg } from "../config";
import type { Home } from "../crm/home";
import { sourceText } from "../crm/leads";
import { personName } from "../crm/people";
import { formatWholeMoney } from "../crm/text";
import { Layout } from "./layout";
import { TaskItem } from "./tasks";
import { Avatar, MESSAGES, dueDayText, timeZone } from "./ui";

const CHIP = { good: "bg-good/10 text-good", late: "bg-late/10 text-late", neutral: "bg-panel text-ink-2" };
type Chip = { text: string; tone: keyof typeof CHIP };

/**
 * One figure, a cell of the stats card: its label, the figure large, then
 * one line of context with a chip where it moved. `count` is the number
 * crm.js counts up to once (its `currency` formats the steps); the text the
 * server wrote is what stays.
 */
function Stat(p: { href: string; label: string; value: string; count: number; currency?: string; sub: string | null; chip?: Chip }) {
  return (
    <a href={p.href} class="group flex min-w-0 flex-col bg-surface px-5 py-4 no-underline hover:bg-canvas focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
      <span class="truncate font-medium text-ink-2 group-hover:text-ink">{p.label}</span>
      <span class="mt-1 text-display font-semibold tabular-nums text-ink" data-count={String(p.count)} data-currency={p.currency}>{p.value}</span>
      <span class="mt-1 flex flex-wrap items-center gap-2 text-label text-ink-3">
        {p.chip ? <span class={"rounded-control px-1.5 py-0.5 font-medium tabular-nums " + CHIP[p.chip.tone]}>{p.chip.text}</span> : null}
        {p.sub}
      </span>
    </a>
  );
}

function Numbers({ h }: { h: Home }) {
  const due = h.due.overdue + h.due.today;
  const whole = (cents: string) => Math.round(Number(cents) / 100);
  const deals = (k: number) => (k === 1 ? `1 ${dealsCfg.one.toLowerCase()}` : `${k} ${dealsCfg.many.toLowerCase()}`);
  const moved = h.leads.current - h.leads.previous;
  return (
    // One card, its cells sharing 1px rules (Tailwind's own stats block): all in a row from lg, two a row below, the odd one out across both.
    <div class={"mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-card bg-line shadow-card ring-1 ring-line [&>*:last-child:nth-child(odd)]:col-span-2 lg:[&>*:last-child:nth-child(odd)]:col-span-1 " + (h.owed ? "lg:grid-cols-5" : "lg:grid-cols-4")}>
      <Stat href="/leads" label="Leads, 7 days" value={String(h.leads.current)} count={h.leads.current}
        sub={`${h.leads.previous} the week before`} chip={moved ? { text: (moved > 0 ? "+" : "") + moved, tone: moved > 0 ? "good" : "neutral" } : undefined} />
      <Stat href="/tasks?who=mine" label="Your tasks due" value={String(due)} count={due}
        sub={h.due.overdue ? null : due ? "All today" : "Nothing overdue"} chip={h.due.overdue ? { text: `${h.due.overdue} overdue`, tone: "late" } : undefined} />
      <Stat href="/deals" label={`Open ${dealsCfg.many.toLowerCase()}`} value={formatWholeMoney(h.open.cents, dealsCfg.currency)}
        count={whole(h.open.cents)} currency={dealsCfg.currency} sub={deals(h.open.count)} />
      <Stat href="/deals" label="Won this month" value={formatWholeMoney(h.won.cents, dealsCfg.currency)}
        count={whole(h.won.cents)} currency={dealsCfg.currency} sub={deals(h.won.count)} />
      {h.owed ? (
        <Stat href={listUrl("/invoices", { status: "open" })} label="Owed" value={formatWholeMoney(h.owed.cents, h.owed.currency)}
          count={whole(h.owed.cents)} currency={h.owed.currency} sub={h.owed.count === 1 ? "1 invoice" : `${h.owed.count} invoices`} />
      ) : null}
    </div>
  );
}

/** One short list as a card: its heading and count, the way to the whole list, then its rows (or a line saying there are none). */
function Panel({ title, href, link, n, empty, children }: { title: string; href: string; link: string; n: number; empty: string; children?: Child }) {
  return (
    <section class="flex min-w-0 flex-col rounded-card bg-surface shadow-card ring-1 ring-line">
      <div class="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 class="flex items-center gap-2 text-heading font-semibold">
          {title}
          {n ? <span class="rounded-full bg-panel px-2 text-label font-medium tabular-nums text-ink-2">{n}</span> : null}
        </h2>
        <a href={href} class="text-label font-medium text-ink-2 no-underline hover:text-ink">{link}</a>
      </div>
      {n ? <ul class="flex flex-col divide-y divide-line px-5">{children}</ul> : <p class="px-5 py-8 text-center text-ink-3">{empty}</p>}
    </section>
  );
}

const row = "py-3";

/** "Good morning", by the hour where the business is. */
function greeting(now: Date): string {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

export function HomePage({ user, h, flash }: { user: string; h: Home; flash: { code?: string | null; n?: string | null } }) {
  const now = new Date();
  // Their first name when the team list knows them; an email alone is not a name to greet.
  const name = personName(user);
  const first = name.includes("@") ? null : name.split(" ")[0];
  return (
    <Layout title="Home" heading={first ? `${greeting(now)}, ${first}` : greeting(now)} user={user} section="home"
      sub={new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(now)}>
      <Flash code={flash.code} n={flash.n} messages={MESSAGES} />
      <Numbers h={h} />
      {/* Two columns that stack on their own, so a short list never leaves an empty box beside a long one. */}
      <div class="grid items-start gap-6 lg:grid-cols-2">
        <div class="flex min-w-0 flex-col gap-6">
          <Panel title="New leads" href="/leads" link="All leads" n={h.newLeads.length} empty="No new leads.">
            {h.newLeads.map((l) => (
              <li class={row + " flex items-center gap-3"}>
                <Avatar name={l.customer_name} />
                <div class="min-w-0 flex-1">
                  <a href={`/leads/${l.id}`} class="block truncate font-medium text-ink no-underline hover:underline">{l.customer_name}</a>
                  <p class="truncate text-label text-ink-3">{sourceText(l)} · <When at={l.created_at} timeZone={timeZone} /></p>
                </div>
              </li>
            ))}
          </Panel>
          <Panel title="Your tasks due" href="/tasks?who=mine" link="All tasks" n={h.tasks.length} empty="Nothing due today.">
            {h.tasks.map((t) => (
              <li class={row}><TaskItem task={t} today={h.today} returnTo="/" showCustomer /></li>
            ))}
          </Panel>
        </div>
        <div class="flex min-w-0 flex-col gap-6">
          {eventsCfg ? (
            <Panel title="Today" href="/schedule" link="Calendar" n={h.events.length} empty={`No ${eventsCfg.many.toLowerCase()} today.`}>
              {h.events.map((e) => (
                <li class={row + " flex gap-3"}>
                  <span class="w-20 shrink-0 tabular-nums text-ink-2">{formatTime(e.starts_at, timeZone)}</span>
                  <div class="min-w-0 flex-1">
                    <a href={`/events/${e.id}`} class="block truncate font-medium text-ink no-underline hover:underline">{e.what}</a>
                    <p class="truncate text-label text-ink-3">{[e.customer_name ?? e.name, e.host_name, e.location].filter(Boolean).join(" · ")}</p>
                  </div>
                </li>
              ))}
            </Panel>
          ) : null}
          <Panel title="Closing this month" href="/deals" link={dealsCfg.many} n={h.closing.length} empty={`No ${dealsCfg.many.toLowerCase()} expected to close this month.`}>
            {h.closing.map((d) => (
              <li class={row + " flex items-center gap-3"}>
                <div class="min-w-0 flex-1">
                  <a href={`/deals/${d.id}`} class="block truncate font-medium text-ink no-underline hover:underline">{d.title}</a>
                  <p class="truncate text-label text-ink-3">
                    {d.customer_name} · <span class={d.expected_close! < h.today ? "font-semibold text-late" : ""}>{dueDayText(d.expected_close!, h.today)}</span>
                  </p>
                </div>
                {d.shown_cents ? <span class="shrink-0 tabular-nums font-medium">{formatWholeMoney(d.shown_cents, d.currency ?? dealsCfg.currency)}</span> : null}
              </li>
            ))}
          </Panel>
        </div>
      </div>
    </Layout>
  );
}

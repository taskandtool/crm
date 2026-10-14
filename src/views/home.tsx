// Home, the first screen, as Jobber's Home: the figures, each a link to the
// list behind it, then four short lists (new leads, today's schedule, your
// tasks due, closing this month), each with a link to the whole list.
// No charts here; they belong on a reports page.
import type { Child } from "hono/jsx";
import { Flash } from "../admin/flash";
import { When } from "../admin/list";
import { listUrl } from "../admin/query";
import { formatTime } from "../booking/slots";
import { dealsCfg, eventsCfg } from "../config";
import type { Home } from "../crm/home";
import { sourceText } from "../crm/leads";
import { formatWholeMoney } from "../crm/text";
import { Layout } from "./layout";
import { TaskItem } from "./tasks";
import { Avatar, MESSAGES, dueDayText, timeZone } from "./ui";

/**
 * The figures, as Catalyst's and Stripe's dashboards have them: no boxes, a
 * rule above, the label, the figure large, then one line of context with a
 * chip where it moved.
 */
function Numbers({ h }: { h: Home }) {
  const due = h.due.overdue + h.due.today;
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
  const moved = h.leads.current - h.leads.previous;
  return (
    <div class={"mb-12 grid grid-cols-2 gap-x-8 gap-y-6 " + (h.owed ? "lg:grid-cols-5" : "lg:grid-cols-4")}>
      {figure("/leads", "New leads, 7 days", String(h.leads.current), `${h.leads.previous} the week before`,
        moved ? { text: (moved > 0 ? "+" : "") + moved, tone: moved > 0 ? "good" : "neutral" } : undefined)}
      {figure("/tasks?who=mine", "Your tasks due", String(due), h.due.overdue ? null : due ? "All today" : "Nothing overdue",
        h.due.overdue ? { text: `${h.due.overdue} overdue`, tone: "late" } : undefined)}
      {figure("/deals", `Open ${dealsCfg.many.toLowerCase()}`, whole(h.open.cents), count(h.open.count))}
      {figure("/deals", "Won this month", whole(h.won.cents), count(h.won.count))}
      {h.owed ? figure(listUrl("/invoices", { status: "open" }), "Owed", formatWholeMoney(h.owed.cents, h.owed.currency), h.owed.count === 1 ? "1 invoice" : `${h.owed.count} invoices`) : null}
    </div>
  );
}

const CHIP = { good: "bg-good/10 text-good", late: "bg-late/10 text-late", neutral: "bg-panel text-ink-2" };

/** One short list: its heading, its rows (or a line saying there are none), and the way to the whole list. */
function Panel({ title, href, link, n, empty, children }: { title: string; href: string; link: string; n: number; empty: string; children?: Child }) {
  return (
    <section class="flex min-w-0 flex-col">
      <div class="mb-2 flex items-baseline justify-between gap-3">
        <h2 class="text-heading font-semibold">{title}</h2>
        <a href={href} class="text-label font-medium">{link} →</a>
      </div>
      {n ? <ul class="flex flex-col border-t border-line">{children}</ul> : <p class="border-t border-line pt-3 text-ink-3">{empty}</p>}
    </section>
  );
}

const row = "border-b border-line py-3";

export function HomePage({ user, h, flash }: { user: string; h: Home; flash: { code?: string | null; n?: string | null } }) {
  return (
    <Layout title="Home" user={user} section="home">
      <Flash code={flash.code} n={flash.n} messages={MESSAGES} />
      <Numbers h={h} />
      <div class="grid gap-x-10 gap-y-10 lg:grid-cols-2">
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
        <Panel title="Your tasks due" href="/tasks?who=mine" link="All tasks" n={h.tasks.length} empty="Nothing due today.">
          {h.tasks.map((t) => (
            <li class={row}><TaskItem task={t} today={h.today} returnTo="/" showCustomer /></li>
          ))}
        </Panel>
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
    </Layout>
  );
}

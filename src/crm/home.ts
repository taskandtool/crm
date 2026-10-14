// Home, the first screen (docs/plans/crm-contacts-leads-deals.md), as
// Jobber's Home: the figures (new leads this week against the week before,
// the viewer's tasks due, the open pipeline, what was won this month, what
// is owed), then four short lists, each a way into its own page. Days and
// months are the business's.
import type { Db } from "../data/db";
import { invoiceTotals } from "../invoices/invoices";
import { addDays, todayIn } from "../reports/sql";
import { dayBounds } from "../booking/slots";
import { closingBy, dealTotals, type Deal } from "./deals";
import { eventsBetween, type Event } from "./events";
import { listLeads, type Lead } from "./leads";
import { listTasks, taskCounts, type Task } from "./tasks";
import { present } from "./tables";

/** How many each list shows. */
export const HOME_LIST = 5;

export type Home = {
  today: string;
  leads: { current: number; previous: number };
  due: { overdue: number; today: number };
  open: { count: number; cents: string };
  won: { count: number; cents: string };
  /** In the invoices' own currency; null when the project has no invoices. */
  owed: { count: number; cents: string; currency: string } | null;
  newLeads: Lead[];
  events: Event[];
  tasks: Task[];
  closing: Deal[];
};

export async function home(db: Db, opts: { timeZone: string; currency: string; invoiceCurrency: string | null; user: string; now?: Date }): Promise<Home> {
  const today = todayIn(opts.timeZone, opts.now);
  const day = (d: string) => dayBounds(d, opts.timeZone);
  const monthStart = `${today.slice(0, 8)}01`;
  const monthEnd = addDays(`${addDays(monthStart, 32).slice(0, 8)}01`, -1);
  const p = await present(db);
  const [leads, due, deals, owed, newLeads, events, tasks, closing] = await Promise.all([
    db.sql<{ current: number; previous: number }>`
      select count(*) filter (where created_at >= ${day(addDays(today, -6)).start})::int as current,
             count(*) filter (where created_at < ${day(addDays(today, -6)).start})::int as previous
      from leads where created_at >= ${day(addDays(today, -13)).start}`,
    taskCounts(db, today, opts.user),
    dealTotals(db, opts.currency, day(monthStart).start),
    p.invoices && opts.invoiceCurrency ? invoiceTotals(db, { today, timeZone: opts.timeZone, currency: opts.invoiceCurrency }) : null,
    listLeads(db, { status: "open" }, HOME_LIST),
    eventsBetween(db, day(today).start, day(today).end),
    listTasks(db, opts.user, HOME_LIST, today),
    closingBy(db, monthEnd, HOME_LIST),
  ]);
  return {
    today, leads: leads[0], due, open: deals.open, won: deals.won, owed: owed && opts.invoiceCurrency ? { ...owed.open, currency: opts.invoiceCurrency } : null,
    newLeads, events, tasks: tasks.slice(0, HOME_LIST), closing,
  };
}

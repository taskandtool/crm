// The four figures at the top of the Inbox: leads in the last seven days
// against the seven before, the viewer's tasks due, the open pipeline,
// and what was won this month. Days and months are the business's.
import type { Db } from "../data/db";
import { addDays, compareQuery, run, todayIn } from "../reports/sql";
import { dealTotals } from "./deals";
import { taskCounts } from "./tasks";
import { present } from "./tables";
import { dayBounds } from "../booking/slots";

export type Overview = {
  /** Null when the project takes no form submissions yet. */
  leads: { current: number; previous: number } | null;
  due: { overdue: number; today: number };
  open: { count: number; cents: string };
  won: { count: number; cents: string };
};

export async function overview(db: Db, opts: { timeZone: string; currency: string; user: string; now?: Date }): Promise<Overview> {
  const today = todayIn(opts.timeZone, opts.now);
  const monthStart = dayBounds(`${today.slice(0, 8)}01`, opts.timeZone).start;
  const p = await present(db);
  const [leads, due, deals] = await Promise.all([
    p.submissions ? run<{ current: number; previous: number }>(db, compareQuery("leads", { from: addDays(today, -6), to: today }, opts.timeZone)) : null,
    taskCounts(db, today, opts.user),
    dealTotals(db, opts.currency, monthStart),
  ]);
  return { leads: leads ? leads[0] : null, due, open: deals.open, won: deals.won };
}

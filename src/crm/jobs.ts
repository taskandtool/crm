// The CRM's scheduled work as its own job routes (data/jobs.ts;
// `schedule-job --route`): in production once deployed, on the dev server
// before. Each answers JSON, a 500 when something failed, so the run's
// history says why (a throw too: jobRoutes). Mounted ahead of the team gate with the request's
// database (app.tsx); booking's two (calendar sync, reminders) are
// booking/jobs.ts's.
//
//   POST /jobs/task-emails          hourly: each person's tasks due, at 7:00 in the business's zone (digest.ts DEFAULT_HOUR; ?hour=H to change)
//   POST /jobs/recurring-invoices   daily, at the UTC hour that is 06:00 in the business's zone
//   POST /jobs/automatic-texts      every 15 minutes: the texts and follow-ups due, the texting registration
import type { Context } from "hono";
import { cfg, invoicesCfg } from "../config";
import { emailSend } from "../booking/notify";
import type { Db } from "../data/db";
import { envOf } from "../data/env";
import { jobRoutes } from "../data/jobs";
import { todayIn } from "../invoices/document";
import { runRecurring } from "../invoices/recurring";
import { stripeFrom } from "../payments/stripe";
import { phoneJob } from "../phone/job";
import type { Production } from "../proposals/serving";
import { sendDigests } from "./digest";
import { recurringTask } from "./recurring";
import { jobCtx, phoneCtx } from "./texting";

/**
 * `productionOf`: where production is, on the machine (Task & Tool says);
 * in production there is none: the job is asked for at the app's own
 * address, which is it.
 */
export function crmJobs(getDb: (c: Context) => Db, productionOf: (c: Context) => (() => Promise<Production | null>) | undefined) {
  const app = jobRoutes();

  app.post("/jobs/task-emails", async (c) => {
    const h = c.req.query("hour");
    const hour = h && /^\d{1,2}$/.test(h) && Number(h) < 24 ? Number(h) : undefined;
    const r = await sendDigests(getDb(c), emailSend(envOf(c)), { timeZone: cfg.time_zone, hour, word: invoicesCfg?.word });
    return c.json({ ok: !r.failed, ...r }, r.failed ? 500 : 200);
  });

  app.post("/jobs/recurring-invoices", async (c) => {
    if (!invoicesCfg) return c.json({ ok: true, skipped: "quotes and invoices are off" });
    const db = getDb(c);
    const r = await runRecurring(db, { today: todayIn(cfg.time_zone), timeZone: cfg.time_zone, stripe: () => stripeFrom(envOf(c)), task: recurringTask(db) });
    return c.json({ ok: !r.failed, ...r }, r.failed ? 500 : 200);
  });

  app.post("/jobs/automatic-texts", async (c) => {
    // In production the job is asked for at the app's own address, and the
    // router says whether customers can open /q there, as on a page.
    const production = productionOf(c);
    const db = getDb(c);
    const r = await phoneJob(production ? await jobCtx(db, envOf(c), production) : await phoneCtx(c, db));
    return c.json({ ok: !r.failed, ...r }, r.failed ? 500 : 200);
  });

  return app;
}

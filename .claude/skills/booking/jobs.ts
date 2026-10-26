// The booking skill's scheduled work as the app's own job routes (data/jobs.ts;
// `schedule-job --route`). Edge-safe: these run in production once the app is
// deployed, on the dev server before.
//
//   app.route("/", bookingJobs(getDb));       // /jobs/calendar-sync, /jobs/booking-reminders
//
// Only the app that owns the calendars (the CRM) mounts /jobs/calendar-sync:
// it links accounts (calendars.ts linkAccounts), which drops the ones the
// calling app does not hold, and the project's tables are shared.
import type { Context } from "hono";
import type { Db } from "../data/db";
import { envOf, type Env } from "../data/env";
import { gatewayFetch, listConnections } from "../data/gateway";
import { jobRoutes } from "../data/jobs";
import { releaseLapsedHolds } from "./book";
import { linkAccounts, type Gateway } from "./calendars";
import { emailSend } from "./notify";
import { DEFAULT_BEFORE, sendReminders } from "./reminders";
import { syncCalendars } from "./sync";

const gatewayOf = (env: Env): Gateway => (slug, path, init) => gatewayFetch(env, slug, path, init);

/**
 * POST /jobs/calendar-sync (every 15 minutes: link new accounts, push, pull
 * busy times) and POST /jobs/booking-reminders (every 15 minutes). Each
 * answers JSON, a 500 when anything failed, so the run's history says why.
 */
export function bookingJobs(getDb: (c: Context) => Db, opts: { calendars?: boolean; before?: number[] } = {}) {
  const app = jobRoutes();

  if (opts.calendars !== false) {
    app.post("/jobs/calendar-sync", async (c) => {
      const env = envOf(c);
      const db = getDb(c);
      const linked = await linkAccounts(db, await listConnections(env));
      const r = await syncCalendars(db, gatewayOf(env));
      return c.json({ ok: !r.errors.length, linked, ...r }, r.errors.length ? 500 : 200);
    });
  }

  app.post("/jobs/booking-reminders", async (c) => {
    const db = getDb(c);
    // Times held for a payment that never came are freed first, so nobody is reminded of them.
    const released = await releaseLapsedHolds(db);
    const r = await sendReminders(db, emailSend(envOf(c)), { before: opts.before ?? DEFAULT_BEFORE });
    return c.json({ ok: !r.failed, released, ...r }, r.failed ? 500 : 200);
  });

  return app;
}

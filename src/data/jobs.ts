// A scheduled route job (`schedule-job --route /_jobs/<name>`), run where the
// app is served: Task & Tool calls the dev server from inside the machine
// before a deploy, and dispatches the production Worker after one. Nobody else
// reaches `/_jobs/`: the routing Worker refuses it, so a route needs no check
// of its own. It replies JSON: the run's output, a 500 when it failed.
// jobRoutes() gives a Hono app whose throws answer that 500:
//
//   const jobs = jobRoutes();
//   jobs.post("/_jobs/booking-reminders", async (c) => {
//     const r = await sendReminders(getDb(c), emailSend(envOf(c)));
//     return c.json({ ok: !r.failed, ...r }, r.failed ? 500 : 200);
//   });
//   app.route("/", jobs);
//
// Edge-safe.
import { Hono, type Context } from "hono";

/** Whether this request is a scheduled job's run: only Task & Tool reaches /_jobs/. */
export function isJob(c: Context): boolean {
  return c.req.path.startsWith("/_jobs/");
}

/** A Hono app for job routes: one that throws answers a JSON 500, so the run says why. */
export function jobRoutes(): Hono {
  const app = new Hono();
  app.onError((e, c) => c.json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 500) }, 500));
  return app;
}

// A scheduled route job (`schedule-job --route /jobs/<name>`), run where the
// app is served. In production the routing Worker dispatches it with
// `props.job`, which only it can set; before a deploy Task & Tool calls the
// dev server with the machine token, which a visitor never has. A job route
// answers only when isJob(c), and replies JSON: the run's output, a 500 when
// it failed. jobRoutes() gives a Hono app that does both:
//
//   const jobs = jobRoutes();
//   jobs.post("/jobs/booking-reminders", async (c) => {
//     const r = await sendReminders(getDb(c), emailSend(envOf(c)));
//     return c.json({ ok: !r.failed, ...r }, r.failed ? 500 : 200);
//   });
//   app.route("/", jobs);
//
// Edge-safe.
import { Hono, type Context } from "hono";
import { envVar } from "./env";

export function isJob(c: Context): boolean {
  let props: { job?: unknown } | undefined;
  try {
    props = (c.executionCtx as { props?: { job?: unknown } }).props;
  } catch {
    props = undefined; // no ExecutionContext: the machine's node-server
  }
  if (typeof props?.job === "string") return c.req.path === `/jobs/${props.job}`;
  const token = envVar(c, "MACHINE_TOKEN");
  return !!token && same(c.req.header("authorization") ?? "", `Bearer ${token}`);
}

/** A Hono app for job routes: nothing but a job reaches them, and one that throws answers a JSON 500. */
export function jobRoutes(): Hono {
  const app = new Hono();
  app.use("/jobs/*", async (c, next) => (isJob(c) ? next() : c.notFound()));
  app.onError((e, c) => c.json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 500) }, 500));
  return app;
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

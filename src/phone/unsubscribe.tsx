// The page an unsubscribe link in a follow-up email opens, on the customer's
// site (the Website's, or the CRM's /q). A press of the button, not the
// open, unsubscribes: mail scanners open links on their own.
//
//   app.route("/q", unsubscribeRoutes(getDb, { page }))
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import type { GetDb } from "../data/db";
import { TOKEN_SHAPE } from "../data/token";
import { unsubscribe } from "./send";

export function unsubscribeRoutes(getDb: GetDb, opts: { business: string; page: (c: Context, title: string, body: Child) => Response | Promise<Response> | string | Promise<string> }) {
  const app = new Hono();
  const show = async (c: Context, body: Child, status = 200) => {
    const r = await opts.page(c, "Unsubscribe", body);
    return typeof r === "string" ? c.html(r, status as 200) : r;
  };
  app.get("/unsubscribe", (c) => {
    const k = c.req.query("k") ?? "";
    if (!TOKEN_SHAPE.test(k)) return show(c, <p>This link isn't complete. Reply to the email and we'll stop.</p>, 404);
    return show(c, (
      <form method="post" action={`unsubscribe?k=${encodeURIComponent(k)}`} class="space-y-4">
        <h1 class="text-title font-semibold">Stop these emails from {opts.business}?</h1>
        <p>You'll still hear from us about a visit you book.</p>
        <button class="rounded-control bg-ink px-4 py-2 font-semibold text-canvas">Unsubscribe</button>
      </form>
    ));
  });
  app.post("/unsubscribe", async (c) => {
    const email = await unsubscribe(getDb(c), c.req.query("k") ?? "");
    if (!email) return show(c, <p>This link isn't one we sent. Reply to the email and we'll stop.</p>, 404);
    return show(c, <><h1 class="text-title font-semibold">You're unsubscribed</h1><p>{email} won't get these emails from {opts.business} again.</p></>);
  });
  return app;
}

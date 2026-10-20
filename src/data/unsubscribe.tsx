// Unsubscribing from the follow-up emails CAN-SPAM counts as commercial: the
// link an email carries, the opt-out it records, and the page the link
// opens on the customer's site (the Website's, or the CRM's /q). A press of
// the button, not the open, unsubscribes: mail scanners open links on their
// own. Tables: schema.sql (email_optouts, unsubscribe_keys). Edge-safe.
//
//   app.route("/q", unsubscribeRoutes(getDb, { page }))
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import { businessOf } from "./business";
import type { Db, GetDb } from "./db";
import { newToken, tokenHash, TOKEN_SHAPE } from "./token";

/** An unsubscribe link for one address at `base` (where the page is mounted); the key's hash is kept, the key only in the email. */
export async function unsubscribeLink(db: Db, base: string, email: string): Promise<string> {
  const key = newToken();
  await db.sql`insert into unsubscribe_keys (hash, email) values (${await tokenHash(key)}, ${email}::citext)`;
  return `${base}/unsubscribe?k=${key}`;
}

/** Unsubscribe the address a link's key was made for: the address, or null for a key we never made. */
export async function unsubscribe(db: Db, key: string): Promise<string | null> {
  if (!TOKEN_SHAPE.test(key)) return null;
  const [r] = await db.sql<{ email: string }>`select email::text as email from unsubscribe_keys where hash = ${await tokenHash(key)}`;
  if (!r) return null;
  await db.sql`insert into email_optouts (email) values (${r.email}::citext) on conflict do nothing`;
  return r.email;
}

export async function emailOptedOut(db: Db, email: string): Promise<boolean> {
  const [r] = await db.sql<{ yes: boolean }>`select exists (select 1 from email_optouts where email = ${email}::citext) as yes`;
  return r.yes;
}

export function unsubscribeRoutes(getDb: GetDb, opts: { page: (c: Context, title: string, body: Child) => Response | Promise<Response> | string | Promise<string> }) {
  const app = new Hono();
  const show = async (c: Context, body: Child, status = 200) => {
    const r = await opts.page(c, "Unsubscribe", body);
    return typeof r === "string" ? c.html(r, status as 200) : r;
  };
  const from = async (c: Context) => (await businessOf(getDb(c))).name ?? "us";
  app.get("/unsubscribe", async (c) => {
    const k = c.req.query("k") ?? "";
    if (!TOKEN_SHAPE.test(k)) return show(c, <p>This link isn't complete. Reply to the email and we'll stop.</p>, 404);
    return show(c, (
      <form method="post" action={`unsubscribe?k=${encodeURIComponent(k)}`} class="space-y-4">
        <h1 class="text-title font-semibold">Stop these emails from {await from(c)}?</h1>
        <p>You'll still hear from us about a visit you book.</p>
        <button class="rounded-control bg-ink px-4 py-2 font-semibold text-canvas">Unsubscribe</button>
      </form>
    ));
  });
  app.post("/unsubscribe", async (c) => {
    const email = await unsubscribe(getDb(c), c.req.query("k") ?? "");
    if (!email) return show(c, <p>This link isn't one we sent. Reply to the email and we'll stop.</p>, 404);
    return show(c, <><h1 class="text-title font-semibold">You're unsubscribed</h1><p>{email} won't get these emails from {await from(c)} again.</p></>);
  });
  return app;
}

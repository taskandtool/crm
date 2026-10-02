// The private side of an app. Mount it on the prefix the app declares private
// (`/admin`, `/reports`), so only signed-in team members reach it:
//
//   import { teamOnly, type TeamVars } from "../admin/guard";
//   const admin = new Hono<{ Variables: TeamVars }>();
//   admin.use("*", teamOnly());
//   app.route("/admin", admin);
//
// Who is asking comes from X-TaskTool-User, which only Task & Tool's edge sets
// (from a verified sign-in) and which it strips from every visitor's request.
// It is present on dev (the app on its machine, always team only), and on a
// public production site only under a private path. With no valid header the answer is 404: a stranger learns
// nothing, not even that the page exists.
//
// Edge-safe: no Node APIs. Off the platform, a local run can stand in a user
// with ADMIN_DEV_USER, honoured only for a request that is really local
// (isLocal below).
import type { Context, MiddlewareHandler } from "hono";
import { envVar } from "../data/env";

export type TeamVars = { user: string };

const EMAILISH = /^[^\s@]+@[^\s@]+$/;

export function teamOnly(): MiddlewareHandler<{ Variables: TeamVars }> {
  return async (c, next) => {
    const user = whoIs(c);
    if (!user) return c.notFound();
    c.set("user", user);
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex");
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !sameOrigin(c)) {
      return c.text("Cross-site request refused.", 403);
    }
    await next();
  };
}

/** The signed-in team member's email, or null. */
export function whoIs(c: Context): string | null {
  const header = c.req.header("x-tasktool-user") ?? "";
  if (EMAILISH.test(header)) return header.toLowerCase();
  const dev = envVar(c, "ADMIN_DEV_USER");
  return dev && isLocal(c) && EMAILISH.test(dev) ? dev.toLowerCase() : null;
}

// The origin check that stands in for a CSRF token: a browser names its origin
// on a cross-site POST, and the app only accepts its own.
export function sameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  const host = c.req.header("x-forwarded-host") || c.req.header("host");
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const site = c.req.header("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

// The URL's host on the machine is whatever the Host header said, so it alone
// proves nothing: anyone who can reach the port can send `Host: localhost`.
// A local request also came in on a loopback socket (when the server says
// which: @hono/node-server's `c.env.incoming`) and through no proxy.
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const PROXIED = ["x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip", "cf-connecting-ip", "fly-client-ip", "via"];

function isLocal(c: Context): boolean {
  let h: string;
  try {
    h = new URL(c.req.url).hostname;
  } catch {
    return false;
  }
  if (h !== "localhost" && h !== "127.0.0.1" && h !== "[::1]") return false;
  if (PROXIED.some((name) => c.req.header(name) !== undefined)) return false;
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: unknown } } } | undefined)?.incoming;
  if (incoming) return typeof incoming.socket?.remoteAddress === "string" && LOOPBACK.test(incoming.socket.remoteAddress);
  return true;
}

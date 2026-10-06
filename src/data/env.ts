// Settings by name, the same way on the machine and at the edge. At the edge
// a setting is a Worker binding in `c.env`; on the machine it is in
// `process.env`. Under @hono/node-server `c.env` is `{ incoming, outgoing }`,
// an object, so `c.env ?? process.env` reads the wrong one there: a binding
// counts only when it is a string, and anything else falls through to the
// process. Edge-safe: `process` is looked up, never assumed.
//
//   const secret = envVar(c, "SPAM_SECRET");
//   const sent = await sendEmail(envOf(c), { ... });     // code that takes an Env
//   const stripe = stripeFrom(envOf(c));
import type { Context } from "hono";

/** Settings by name: a plain record (process.env, a test's object) or a reader such as envOf(c). */
export type Env = Record<string, unknown> | ((name: string) => string | undefined);

/** A setting from the Worker's bindings at the edge, or the process env on the machine. */
export function envVar(c: Context, name: string): string | undefined {
  const bound = (c.env as Record<string, unknown> | undefined)?.[name];
  if (typeof bound === "string") return bound;
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

/** This request's settings as an Env, read by name when asked. */
export function envOf(c: Context): Env {
  return (name) => envVar(c, name);
}

/** One setting, trimmed; undefined when it is missing, empty or not text. */
export function setting(env: Env, name: string): string | undefined {
  const v = typeof env === "function" ? env(name) : env[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * The env name a connection's key has where the owner bound it (delivery
 * `edge` or `machine`): `<SLUG>_API_KEY`, so `resend` is RESEND_API_KEY and
 * `resend-2` is RESEND_2_API_KEY. `python3 ~/tools/taskandtool.py list-connections` shows the real env_name.
 */
export function keyName(slug: string): string {
  return slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY";
}

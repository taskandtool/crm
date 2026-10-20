// A call to a connection through the Task & Tool gateway, from the machine.
// The gateway adds the vendor's credential, so no key is ever here: the
// request goes to `${PHOENIX_URL}/api/machine/gateway/<slug><vendor path>` with
// `Authorization: Bearer ${MACHINE_TOKEN}`. Both exist only on the app's
// machine, so code at the edge cannot use this; there a key the owner bound
// to the Worker is called directly.
//
//   const res = await gatewayFetch(process.env, "google-calendar", "/calendar/v3/calendars/primary/events");
//
// A refusal by Task & Tool (not granted, needs reconnecting) carries an
// `x-tasktool-refusal` header; the vendor's own errors come back as they are.
import { setting, type Env } from "./env";

/** Task & Tool's address and this machine's token; throws off the machine. */
function machine(env: Env): { base: string; token: string } {
  const base = setting(env, "PHOENIX_URL");
  const token = setting(env, "MACHINE_TOKEN");
  if (!base || !token) throw new Error("PHOENIX_URL and MACHINE_TOKEN are not set: the gateway is reachable only from the app's machine.");
  return { base: base.replace(/\/+$/, ""), token };
}

/** Throws when this runtime has no gateway (not on the machine). The default timeout is 60 seconds. */
export async function gatewayFetch(env: Env, slug: string, path: string, init: RequestInit = {}, doFetch: typeof fetch = fetch): Promise<Response> {
  const { base, token } = machine(env);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`not a connection slug: ${slug}`);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return doFetch(`${base}/api/machine/gateway/${slug}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(60_000) });
}

/**
 * A connection this app holds, one per granted endpoint, as Task & Tool's
 * list-connections gives it: `slug` is what this app calls it, and two
 * people's Google are `google-calendar` and `google-calendar-7c2e1a`, told
 * apart by `account`.
 */
export type GrantedConnection = { slug: string; provider: string; service: string | null; account: string | null };

/** What this app holds right now (`GET /api/machine/connections`). Throws off the machine or when Task & Tool refuses. */
export async function listConnections(env: Env, doFetch: typeof fetch = fetch): Promise<GrantedConnection[]> {
  const { base, token } = machine(env);
  const res = await doFetch(`${base}/api/machine/connections`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Task & Tool's list-connections answered ${res.status}`);
  const body = (await res.json()) as { connections?: Partial<GrantedConnection>[] };
  // Secrets and the database are listed too, with no slug: nothing to call.
  return (body.connections ?? []).filter((c): c is GrantedConnection => typeof c.slug === "string");
}

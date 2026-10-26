// A call to a connection through Task & Tool, which adds the vendor's
// credential, so no key is ever here. In production (the app's Worker) it
// goes through the connections the routing Worker hands each request
// (`TT`, connectionsOf); on the machine to
// `${PHOENIX_URL}/api/machine/gateway/<slug><vendor path>` with
// `Authorization: Bearer ${MACHINE_TOKEN}`. The same call works in both.
//
//   const res = await gatewayFetch(envOf(c), "google-calendar", "/calendar/v3/calendars/primary/events");
//
// A refusal by Task & Tool (not granted, needs reconnecting) carries an
// `x-tasktool-refusal` header; the vendor's own errors come back as they are.
import { connectionsOf, setting, type Env } from "./env";

/** Whether this runtime reaches the app's connections: production's `TT`, or the machine's gateway. */
export function gatewayReachable(env: Env): boolean {
  return !!connectionsOf(env) || !!(setting(env, "PHOENIX_URL") && setting(env, "MACHINE_TOKEN"));
}

/** Task & Tool's address and this machine's token. */
function machine(env: Env): { base: string; token: string } {
  const base = setting(env, "PHOENIX_URL");
  const token = setting(env, "MACHINE_TOKEN");
  if (!base || !token) throw new Error("No connections here: neither production's (TT) nor the machine's (PHOENIX_URL and MACHINE_TOKEN).");
  return { base: base.replace(/\/+$/, ""), token };
}

/** Throws when this runtime reaches no connections (gatewayReachable). The default timeout is 60 seconds. */
export async function gatewayFetch(env: Env, slug: string, path: string, init: RequestInit = {}, doFetch: typeof fetch = fetch): Promise<Response> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`not a connection slug: ${slug}`);
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const tt = connectionsOf(env);
  const signal = init.signal ?? AbortSignal.timeout(60_000);
  if (tt) return tt.fetch(`https://tt/${slug}${path}`, { ...init, headers, signal });
  const { base, token } = machine(env);
  headers.set("Authorization", `Bearer ${token}`);
  return doFetch(`${base}/api/machine/gateway/${slug}${path}`, { ...init, headers, signal });
}

/**
 * A connection this app holds, one per granted endpoint, as Task & Tool's
 * list-connections gives it: `slug` is what this app calls it, and two
 * people's Google are `google-calendar` and `google-calendar-7c2e1a`, told
 * apart by `account`.
 */
export type GrantedConnection = { slug: string; provider: string; service: string | null; account: string | null };

/** What this app holds right now, in production or on the machine. Throws where neither is reachable or when Task & Tool refuses. */
export async function listConnections(env: Env, doFetch: typeof fetch = fetch): Promise<GrantedConnection[]> {
  const tt = connectionsOf(env);
  const body = (tt ? await tt.list() : await fromMachine(env, doFetch)) as { connections?: Partial<GrantedConnection>[] };
  // Secrets and the database are listed too, with no slug: nothing to call.
  return (body.connections ?? []).filter((c): c is GrantedConnection => typeof c.slug === "string");
}

async function fromMachine(env: Env, doFetch: typeof fetch): Promise<unknown> {
  const { base, token } = machine(env);
  const res = await doFetch(`${base}/api/machine/connections`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Task & Tool's list-connections answered ${res.status}`);
  return res.json();
}

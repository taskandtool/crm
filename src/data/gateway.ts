// A call to a connection through the Task & Tool gateway, from the machine.
// The gateway adds the vendor's credential, so no key is ever here: the
// request goes to `${PHOENIX_URL}/api/sprite/gateway/<slug><vendor path>` with
// `Authorization: Bearer ${MACHINE_TOKEN}`. Both exist only on the app's
// machine, so code at the edge cannot use this; there a key the owner bound
// to the Worker is called directly.
//
//   const res = await gatewayFetch(process.env, "google-calendar", "/calendar/v3/calendars/primary/events");
//
// A refusal by Task & Tool (not granted, needs reconnecting) carries an
// `x-tasktool-refusal` header; the vendor's own errors come back as they are.
import { setting, type Env } from "./env";

/** Throws when this runtime has no gateway (not on the machine). The default timeout is 60 seconds. */
export async function gatewayFetch(env: Env, slug: string, path: string, init: RequestInit = {}, doFetch: typeof fetch = fetch): Promise<Response> {
  const base = setting(env, "PHOENIX_URL");
  const token = setting(env, "MACHINE_TOKEN");
  if (!base || !token) throw new Error("PHOENIX_URL and MACHINE_TOKEN are not set: the gateway is reachable only from the app's machine.");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`not a connection slug: ${slug}`);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return doFetch(`${base.replace(/\/+$/, "")}/api/sprite/gateway/${slug}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(60_000) });
}

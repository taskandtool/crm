// A small Stripe caller that runs on the machine and at the edge. No SDK: one
// fetch, form-encoded, with an Idempotency-Key on every POST.
//
//   const stripe = stripeFrom(envOf(c));     // a route: the Worker's bindings, or process.env on the machine
//   const stripe = stripeFrom(process.env);  // a script on the machine
//   const session = await stripe("POST", "/v1/checkout/sessions", params, { idempotencyKey: `checkout-${id}` });
//
// Where the key is:
// - The owner bound it to this app (delivery `edge` or `machine`): it is in
//   the env under the connection's env_name (`STRIPE_API_KEY` for slug
//   `stripe`), and the call goes straight to api.stripe.com. This is the only
//   way edge code can call Stripe.
// - Otherwise (the default, `brokered`) the key never leaves Task & Tool: the
//   call goes through the gateway (data/gateway.ts), which exists only
//   on the machine.
import { keyName, setting, type Env } from "../data/env";
import { gatewayFetch } from "../data/gateway";

export type Params = { [key: string]: Param };
type Param = string | number | boolean | null | undefined | Param[] | { [key: string]: Param };

export type Stripe = <T = any>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: Params,
  opts?: { idempotencyKey?: string },
) => Promise<T>;

/** Stripe's own error (`type`, `code`, `message`), or Task & Tool's refusal (`refusal`). */
export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type?: string,
    readonly code?: string,
    readonly refusal?: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

const API = "https://api.stripe.com";

/** `slug` is the Stripe connection's endpoint slug when it is not `stripe` (list_connections()). */
export function stripeFrom(env: Env, fetchImpl: typeof fetch = fetch, slug = "stripe"): Stripe {
  const key = setting(env, keyName(slug));
  if (!key && !(setting(env, "PHOENIX_URL") && setting(env, "MACHINE_TOKEN"))) {
    throw new Error(
      `No Stripe here: no ${keyName(slug)} binding and no gateway. Ask the owner with request_connection("stripe", why), with delivery="edge" for code that runs at the edge.`,
    );
  }

  return async (method, path, params, opts) => {
    if (method === "POST" && !opts?.idempotencyKey) throw new Error(`POST ${path} needs an idempotencyKey`);
    const form = params ? formEncode(params) : "";
    const target = path + (method !== "POST" && form ? "?" + form : "");
    const headers: Record<string, string> = {};
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Idempotency-Key"] = opts!.idempotencyKey!;
    }
    const init: RequestInit = { method, headers, body: method === "POST" ? form : undefined };
    const res = key
      ? await fetchImpl(API + target, { ...init, headers: { ...headers, Authorization: `Bearer ${key}` } })
      : await gatewayFetch(env, slug, target, init, fetchImpl);
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON: reported below */
    }
    const refusal = res.headers.get("x-tasktool-refusal");
    if (refusal) throw new StripeError(`Task & Tool refused the call: ${body?.error ?? refusal}`, res.status, undefined, undefined, refusal);
    if (!res.ok) {
      const e = body?.error ?? {};
      throw new StripeError(e.message ?? `Stripe answered ${res.status}`, res.status, e.type, e.code);
    }
    if (body === null) throw new StripeError(`Stripe answered ${res.status} without JSON`, res.status);
    return body;
  };
}

/**
 * Stripe's form encoding: nested objects and arrays become bracketed keys,
 * `metadata[ref_type]=booking`, `line_items[0][price_data][currency]=usd`.
 * null and undefined are left out; "" is kept (Stripe reads it as "unset").
 */
export function formEncode(params: Params): string {
  const out = new URLSearchParams();
  const walk = (key: string, v: Param) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) v.forEach((item, i) => walk(`${key}[${i}]`, item));
    else if (typeof v === "object") for (const [k, item] of Object.entries(v)) walk(`${key}[${k}]`, item);
    else out.append(key, String(v));
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.toString().replace(/%5B/g, "[").replace(/%5D/g, "]");
}

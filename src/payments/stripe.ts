// A small Stripe caller that runs on the machine and at the edge. No SDK: one
// fetch, form-encoded, with an Idempotency-Key on every POST.
//
//   const stripe = stripeFrom(envOf(c));     // a route: the Worker's bindings, or process.env on the machine
//   const stripe = stripeFrom(process.env);  // a script on the machine
//   const session = await stripe("POST", "/v1/checkout/sessions", params, { idempotencyKey: `checkout-${id}` });
//
// The key never reaches the app: every call goes through the app's
// connections (data/gateway.ts), in dev and production alike.
import type { Env } from "../data/env";
import { gatewayFetch, gatewayReachable } from "../data/gateway";

export type Params = { [key: string]: Param };
type Param = string | number | boolean | null | undefined | Param[] | { [key: string]: Param };

export type Stripe = <T = any>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: Params,
  /** `version` pins Stripe's API version for a call that needs a newer one than the account's default; `timeout` is in milliseconds. */
  opts?: { idempotencyKey?: string; version?: string; timeout?: number },
) => Promise<T>;

/** The message when this app holds no Stripe connection, for a caller that says so its own way. */
export const NOT_CONNECTED = "Stripe is not connected to this app";

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

/** `slug` is the Stripe connection's endpoint slug when it is not `stripe` (list-connections). */
export function stripeFrom(env: Env, fetchImpl: typeof fetch = fetch, slug = "stripe"): Stripe {
  if (!gatewayReachable(env)) {
    throw new Error(
      `No Stripe here: this runtime reaches no connections. Ask the owner: python3 ~/tools/taskandtool.py request-connection stripe --why "<what it is for>" --auth api_key`,
    );
  }

  return async (method, path, params, opts) => {
    if (method === "POST" && !opts?.idempotencyKey) throw new Error(`POST ${path} needs an idempotencyKey`);
    const form = params ? formEncode(params) : "";
    const target = path + (method !== "POST" && form ? "?" + form : "");
    const headers: Record<string, string> = {};
    if (opts?.version) headers["Stripe-Version"] = opts.version;
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Idempotency-Key"] = opts!.idempotencyKey!;
    }
    const init: RequestInit = { method, headers, body: method === "POST" ? form : undefined, signal: opts?.timeout ? AbortSignal.timeout(opts.timeout) : undefined };
    const res = await gatewayFetch(env, slug, target, init, fetchImpl);
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON: reported below */
    }
    const refusal = res.headers.get("x-tasktool-refusal");
    if (refusal === "unknown_connection") throw new StripeError(NOT_CONNECTED, res.status, undefined, undefined, refusal);
    if (refusal) throw new StripeError(`Task & Tool refused the call: ${body?.error ?? refusal}`, res.status, undefined, undefined, refusal);
    if (!res.ok) {
      const e = body?.error ?? {};
      throw new StripeError(e.message ?? `Stripe answered ${res.status}`, res.status, e.type, e.code);
    }
    if (body === null) throw new StripeError(`Stripe answered ${res.status} without JSON`, res.status);
    return body;
  };
}

let reach: { slug: string; at: number; ok: boolean } | null = null;

/**
 * Whether this app reaches the owner's Stripe through its connections. Stripe is asked (a balance read, the
 * cheapest call) and the answer kept a few minutes, a no only half a
 * minute, so a page shows the change soon after the owner connects. null
 * when Stripe could not be asked (a network error, or no answer in 3
 * seconds): a page should not then claim Stripe is missing, nor wait on it.
 */
export async function stripeConnected(env: Env, fetchImpl: typeof fetch = fetch, slug = "stripe"): Promise<boolean | null> {
  if (reach && reach.slug === slug && Date.now() - reach.at < (reach.ok ? 300_000 : 30_000)) return reach.ok;
  let ok = false;
  if (gatewayReachable(env)) {
    try {
      await stripeFrom(env, fetchImpl, slug)("GET", "/v1/balance", undefined, { timeout: 3000 });
      ok = true;
    } catch (e) {
      if (!(e instanceof StripeError) || (!e.refusal && e.status !== 401 && e.status !== 403)) return null;
    }
  }
  reach = { slug, at: Date.now(), ok };
  return ok;
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

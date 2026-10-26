// Where a proposal's link points, and whether a customer can open it now.
// The link is on production: on the machine its address comes from Task &
// Tool (runtime.production, serving.ts); in production it is this host.
// PROPOSAL_BASE_URL, when set, names it outright (a local run, a test).
//
// Ready means a customer can open /q on production. On the machine that is
// asked of production itself: it answers /q/ as this app does (the
// X-Proposals header) when it is deployed with proposals and /q is open. In
// production the edge says which paths are open on every request
// (X-TaskTool-Public-Paths): a Worker cannot reach its own address. Anything
// else is a sentence saying which, and Send goes without a link.
import type { Context } from "hono";
import { envVar } from "../data/env";
import type { Production } from "./serving";

export const PROPOSALS_HEADER = "x-proposals";

export type Base = { ok: true; base: string } | { ok: false; why: string };

/** Production's address for this request's app. */
export async function linkBase(c: Context, production?: () => Promise<Production | null>): Promise<Base> {
  const set = envVar(c, "PROPOSAL_BASE_URL");
  if (set) return { ok: true, base: set.replace(/\/+$/, "") };
  if (!production) {
    // In production: this host is the published address.
    const host = c.req.header("x-forwarded-host") || c.req.header("host");
    return host ? { ok: true, base: `https://${host}` } : { ok: false, why: "this request has no host to link to." };
  }
  const p = await production();
  if (!p) return { ok: false, why: "Task & Tool did not say where production is just now." };
  if (!p.url) return { ok: false, why: "this app has no production address yet." };
  if (!p.deployed) return { ok: false, why: "this app has never been deployed to production, where customers open the link." };
  return { ok: true, base: p.url.replace(/\/+$/, "") };
}

const NOT_OPEN = "customers cannot open /q/ on production yet: a person turns it on in the app's Settings in Task & Tool (Let customers open proposals).";

/** Null when customers can open this request's links; else why not. Production asks the edge's header, the machine asks production. */
export async function readyHere(c: Context, production?: () => Promise<Production | null>): Promise<string | null> {
  const b = await linkBase(c, production);
  if (!b.ok) return b.why;
  if (production || envVar(c, "PROPOSAL_BASE_URL")) return linkReady(b.base);
  // The router's list of what anyone may open: `*` on a public site.
  const open = (c.req.header("x-tasktool-public-paths") ?? "").split(",").map((p) => p.trim());
  return open.some((p) => p === "/q" || p === "*") ? null : NOT_OPEN;
}

/** Null when customers can open links at `base`; else why not, in a sentence. */
export async function linkReady(base: string, doFetch: typeof fetch = fetch): Promise<string | null> {
  let res: Response;
  try {
    res = await doFetch(`${base}/q/`, { redirect: "manual", signal: AbortSignal.timeout(8000) });
  } catch {
    return "production did not answer just now.";
  }
  if (res.headers.get(PROPOSALS_HEADER) === "1") return null;
  if (res.status >= 300 && res.status < 400) return NOT_OPEN;
  return "production runs a version from before proposals: deploy it again.";
}

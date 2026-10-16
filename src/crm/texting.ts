// The phone skill as this CRM runs it: the phone context for a request and
// for the job, where a customer's links go, and what a call or text that
// makes a lead adds (its Call back task). Calls and texts are the phone
// skill's (src/phone); this file only says what is the CRM's.
//
// Where links go: the Website's own address when it has the booking pages
// (crm.config.json booking_page), else this CRM's production under /q,
// once customers can open /q there (proposals/link.ts readyHere). Neither:
// texts carry no link.
import type { Context } from "hono";
import { cfg, invoicesCfg } from "../config";
import type { Db } from "../data/db";
import { envOf, type Env } from "../data/env";
import { linkBase, linkReady, readyHere } from "../proposals/link";
import type { Production } from "../proposals/serving";
import type { Links, PhoneCtx } from "../phone/send";
import { mainNumber } from "../phone/store";
import { twilioFrom, twilioReachable } from "../phone/twilio";
import { todayIn } from "../reports/sql";
import { addTask } from "./tasks";

/** The business's name for texts, if crm.config.json gives one: phone.name, else the name on quotes. */
const givenName = (): string | null => cfg.phone?.name?.trim() || invoicesCfg?.name || null;
/** The name texts sign with, "us" when none is given. */
export const textName = (): string => givenName() ?? "us";
/** No name given yet: the setup page asks for one. */
export const nameNeeded = (): boolean => !givenName();

let known: { at: number; links: Links } | null = null;
let unknownUntil = 0;

/**
 * Where a customer's links go from here. A good answer is kept five minutes
 * (finding it takes a request); a miss, thirty seconds. A webhook in
 * production (Twilio, Stripe) comes through Task & Tool's inbound route, whose
 * host is not the app's, so it only reuses an answer a page request found.
 */
async function linksFrom(find: () => Promise<Links | null>, fromHook: boolean): Promise<Links | null> {
  if (cfg.booking_page) return { base: new URL(cfg.booking_page).origin, prefix: "" };
  if (!invoicesCfg) return null;
  if (known && Date.now() - known.at < 300_000) return known.links;
  if (fromHook || Date.now() < unknownUntil) return null;
  const links = await find().catch(() => null);
  if (links) known = { at: Date.now(), links };
  else unknownUntil = Date.now() + 30_000;
  return links;
}

/** Asked once per context, and only when a text needs a link. */
const once = <T>(f: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | null = null;
  return () => (p ??= f());
};

/** This request's phone context. */
export async function phoneCtx(c: Context, db: Db, production?: () => Promise<Production | null>): Promise<PhoneCtx> {
  const env = envOf(c);
  const fromHook = !production && !!c.req.header("x-tasktool-inbound-token");
  return ctxFor(db, env, once(() => linksFrom(async () => {
    const b = await linkBase(c, production);
    if (!b.ok) return null;
    // On the machine production is asked; in production, the edge says whether /q is open.
    const open = production ? !(await linkReady(b.base)) : !(await readyHere(c));
    return open ? { base: b.base, prefix: "/q" } : null;
  }, fromHook)));
}

/**
 * Where the team opens the CRM, for a link texted to the owner: production
 * (the machine asks Task & Tool; a page request in production is on it).
 * A webhook in production can't tell from its own host; it uses what a page
 * request found, else null.
 */
export async function teamBase(c: Context, production?: () => Promise<Production | null>): Promise<string | null> {
  if (production) {
    const b = await linkBase(c, production);
    return b.ok ? b.base : null;
  }
  if (c.req.header("x-tasktool-inbound-token")) return known?.links.prefix === "/q" ? known.links.base : null;
  return new URL(c.req.url).origin;
}

/** The job's phone context, on the machine: production's address from Task & Tool. */
export async function jobCtx(db: Db, env: Env, production: () => Promise<Production | null>): Promise<PhoneCtx> {
  return ctxFor(db, env, once(() => linksFrom(async () => {
    const p = await production();
    const base = p?.url && p.deployed ? p.url.replace(/\/+$/, "") : null;
    return base && !(await linkReady(base)) ? { base, prefix: "/q" } : null;
  }, false)));
}

async function ctxFor(db: Db, env: Env, links: () => Promise<Links | null>): Promise<PhoneCtx> {
  const n = await mainNumber(db).catch(() => null);
  return {
    db, env, provider: twilioReachable(env) ? twilioFrom(env) : null, business: textName(), unnamed: nameNeeded(), zone: cfg.time_zone,
    links, reviewLink: cfg.phone?.review_link ?? null, address: cfg.phone?.address ?? null,
    statusUrl: n?.hooks_url ? `${n.hooks_url}/status?n=${n.id}` : null,
  };
}

/** A new caller or texter is a lead: their Call back task today, nobody's until someone takes it. */
export async function callBackTask(db: Db, l: { customerId: string; title: string }, user: string | null): Promise<void> {
  if (cfg.tasks?.new_lead === false) return;
  const [c] = await db.sql<{ name: string }>`select name from customers where id = ${l.customerId}::bigint`;
  await addTask(db, l.customerId, { kind: "call", title: `Call back ${c?.name ?? "them"}`, due_on: todayIn(cfg.time_zone), due_time: null, owner: user, deal_id: null }, user ?? "phone");
}

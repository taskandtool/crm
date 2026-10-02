// Shared by the command-line scripts: the database, the argument parser,
// output. Every script sets the database up first (the same idempotent
// setup the service runs), so it works on a fresh project too.
import type pg from "pg";
import { cfg } from "../src/config";
import type { Db } from "../src/data/db";
import { fromPool } from "../src/data/pg";
import { databaseUrl } from "../src/db/client";
import { openPool } from "../src/db/pool";
import { setup } from "../src/db/setup";
import type { Customer } from "../src/crm/customers";
import { findCustomer } from "../src/crm/customers";

export type Args = { _: string[]; flags: Record<string, string | boolean> };

// `cmd sub "Ann Lee" --tag a --tag b --json`. A repeated flag collects into
// a list (flags() reads it); a bare flag is true.
export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const next = argv[i + 1];
      let v: string | boolean = true;
      if (inline !== undefined) v = inline;
      else if (next !== undefined && !next.startsWith("--")) {
        v = next;
        i++;
      }
      const prev = out.flags[k];
      out.flags[k] = typeof prev === "string" && typeof v === "string" ? `${prev}\u0000${v}` : v;
    } else out._.push(a);
  }
  return out;
}

export const flag = (a: Args, k: string): string | undefined => (typeof a.flags[k] === "string" ? (a.flags[k] as string).split("\u0000").pop() : undefined);
export const flags = (a: Args, k: string): string[] => (typeof a.flags[k] === "string" ? (a.flags[k] as string).split("\u0000") : []);
export const has = (a: Args, k: string) => a.flags[k] !== undefined;

export async function withDb<T>(fn: (db: Db, pool: pg.Pool) => Promise<T>): Promise<T> {
  const url = databaseUrl();
  if (!url) {
    console.error("DATABASE_URL is not set. On Task & Tool it is in /home/sprite/.env once the project has a database; off it, put one in .env.");
    process.exit(2);
  }
  const pool = openPool(url);
  try {
    const db = fromPool(pool);
    await setup(db, cfg.stages);
    return await fn(db, pool);
  } finally {
    await pool.end();
  }
}

/** Who acted: --as, else CRM_USER, else "AI". */
export const who = (a: Args) => flag(a, "as") || process.env.CRM_USER || "AI";

export async function resolveCustomer(db: Db, ref: string | undefined): Promise<Customer> {
  if (!ref) fail("name a customer by id, email or phone");
  const c = await findCustomer(db, ref);
  if (!c) fail(`no customer ${ref} (by id, email or phone); find one with: node scripts/customers.mjs find <text>`);
  return c;
}

export function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

export function out(json: boolean, data: unknown, text: () => string) {
  console.log(json ? JSON.stringify(data, null, 2) : text());
}

/** A time as the business sees it: "2026-10-02, 14:30" in crm.config.json's zone, never UTC. */
export const local = (d: Date | string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: cfg.time_zone, dateStyle: "short", timeStyle: "short", hourCycle: "h23" }).format(new Date(d));
const day = (d: Date | string | null) => (d ? new Intl.DateTimeFormat("en-CA", { timeZone: cfg.time_zone, dateStyle: "short" }).format(new Date(d)) : "");

export function fmtCustomer(c: Customer, stageLabel?: string): string {
  return [
    `#${c.id}`,
    c.name,
    `[${stageLabel ?? c.stage}]`,
    c.email ?? "",
    c.phone ?? "",
    c.company ? `(${c.company})` : "",
    c.owner ? `@${c.owner}` : "",
    c.tags.length ? c.tags.map((t) => `#${t}`).join(" ") : "",
    c.last_contact_at ? `last contact ${day(c.last_contact_at)}` : "",
    c.archived_at ? "(archived)" : "",
  ]
    .filter(Boolean)
    .join("  ");
}

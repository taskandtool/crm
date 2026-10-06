// Shared by the command-line scripts: the database, this CRM's customers and
// settings; the argument parser and output are the data skill's (data/cli.ts). Every script sets the database up first (the same idempotent
// setup the service runs, skipped while crm_setup says it is current), so it works on a fresh project too.
import type pg from "pg";
import { cfg, invoicesCfg, showBooking } from "../src/config";
import { fail, flag, localTime, machineEnv, type Args } from "../src/data/cli";
import type { Db } from "../src/data/db";
import { fromPool } from "../src/data/pg";
import { databaseUrl } from "../src/db/client";
import { openPool } from "../src/db/pool";
import { setupOnce } from "../src/db/setup";
import type { Customer } from "../src/crm/customers";
import { findCustomer } from "../src/crm/customers";
import type { InvoicesCli } from "../src/invoices/cli";
import { printPdf } from "../src/pdf";

export { fail, flag, flags, has, machineEnv, misused, out, parseArgs, usage, type Args } from "../src/data/cli";

/** The database, set up first; `force` applies every schema file even when crm_setup says it is current (migrate.mjs). */
export async function withDb<T>(fn: (db: Db, pool: pg.Pool) => Promise<T>, opts: { force?: boolean } = {}): Promise<T> {
  const url = databaseUrl();
  if (!url) {
    console.error("DATABASE_URL is not set. On Task & Tool it is in /home/sprite/.env once the project has a database; off it, put one in .env.");
    process.exit(2);
  }
  const pool = openPool(url);
  try {
    const db = fromPool(pool);
    await setupOnce(db, cfg.stages, { booking: showBooking, invoices: !!invoicesCfg }, opts.force);
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

/** A time as the business sees it: "2026-10-02, 14:30" in crm.config.json's zone, never UTC. */
export const local = (d: Date | string) => localTime(d, cfg.time_zone);
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

/** What quotes.mjs and invoices.mjs need from this CRM: its database, settings and customers. */
export function cliSettings(script: "quotes" | "invoices"): InvoicesCli {
  const iv = invoicesCfg;
  return {
    withDb: (fn) => withDb((db) => fn(db)),
    business: iv?.name ?? "",
    currency: iv?.currency ?? "usd",
    timeZone: cfg.time_zone,
    terms: iv?.terms ?? null,
    daysUntilDue: iv?.days_until_due ?? 30,
    source: "crm",
    env: machineEnv(),
    print: printPdf,
    person: async (db, ref) => {
      const c = await findCustomer(db, ref);
      return c ? { email: c.email, name: c.name, phone: c.phone, address: c.address } : null;
    },
    off: iv ? null : `${script} are off: crm.config.json has "invoices": false. Turn them on with { "name": "<the business name>", "currency": "USD" }.`,
  };
}

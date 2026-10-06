// Shared by the command-line scripts: the database, this CRM's customers and
// settings; arguments, usage and output are the data skill's (src/data/cli.mjs).
// Every script sets the database up first (the same idempotent setup the
// service runs, skipped while crm_setup says it is current), so it works on a
// fresh project too.
import type pg from "pg";
import { cfg, invoicesCfg, showBooking } from "../src/config";
import { fail, flag, localTime, machineEnv, misused, parseArgs, type Args } from "../src/data/cli.mjs";
import type { Db } from "../src/data/db";
import { fromPool } from "../src/data/pg";
import { databaseUrl } from "../src/db/client";
import { openPool } from "../src/db/pool";
import { setupOnce } from "../src/db/setup";
import type { Customer } from "../src/crm/customers";
import { findCustomer } from "../src/crm/customers";
import type { InvoicesCli } from "../src/invoices/cli";
import { printPdf } from "../src/pdf";

export { done, fail, flag, flags, has, limitOf, misused, noMore, out, parseArgs, plain, usage } from "../src/data/cli.mjs";

// "customers add": this script and its command, the start of every error line.
const script = (process.argv[1] ?? "").split("/").pop()?.replace(/\.(ts|mjs)$/, "") ?? "";
const at = [script, ["import", "export", "migrate"].includes(script) ? undefined : parseArgs(process.argv.slice(2))._[0]].filter(Boolean).join(" ");

/**
 * The database, set up first; `force` applies every schema file even when
 * crm_setup says it is current (migrate.mjs). No database, or one that does not
 * answer, is exit 1 with the step that fixes it, never a stack trace.
 */
export async function withDb<T>(fn: (db: Db, pool: pg.Pool) => Promise<T>, opts: { force?: boolean } = {}): Promise<T> {
  const url = databaseUrl();
  if (!url) {
    fail(`${at}: the project has no database yet (DATABASE_URL is not set; off Task & Tool, put one in .env)`, "python3 ~/tools/taskandtool.py request-capability postgres");
  }
  const pool = openPool(url);
  const db = fromPool(pool);
  try {
    try {
      await setupOnce(db, cfg.stages, { booking: showBooking, invoices: !!invoicesCfg }, opts.force);
    } catch (e) {
      const err = e as Error & { code?: string };
      return fail(`${at}: ${unreachable(err) ? `cannot reach the database (${err.code})` : `the database could not be set up: ${err.message}`}`, "node scripts/migrate.mjs");
    }
    try {
      return await fn(db, pool);
    } catch (e) {
      // The command's own failure, said as itself: only a lost connection is the database's.
      const err = e as Error & { code?: string };
      if (unreachable(err)) return fail(`${at}: lost the database (${err.code})`, `${run(at)} again, once node scripts/migrate.mjs answers`);
      return fail(`${at}: ${err.message || String(e)}`, `node scripts/${script}.mjs --help`);
    }
  } finally {
    await pool.end();
  }
}

/** A connection that failed or dropped (ECONNREFUSED, ETIMEDOUT, ENOTFOUND...), not an error Postgres answered with. */
const unreachable = (e: { code?: string }) => !!e.code && /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE)/.test(e.code);

/** "customers list" as the command that runs it: "node scripts/customers.mjs list". */
export const run = (at: string) => at.replace(/^(\S+)/, "node scripts/$1.mjs");

/** Who acted: --as, else CRM_USER, else "AI". */
export const who = (a: Args) => flag(a, "as") || process.env.CRM_USER || "AI";

/** <who>: a customer by id, email or phone. `at` is "customers show". */
export async function resolveCustomer(db: Db, ref: string | undefined, at: string): Promise<Customer> {
  if (!ref) misused(`${at}: name a customer by id, email or phone`, "node scripts/customers.mjs find <name>");
  return (await findCustomer(db, ref)) ?? fail(`${at}: no customer ${ref} (by id, email or phone)`, `node scripts/customers.mjs find ${JSON.stringify(ref)}`);
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

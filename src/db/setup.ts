// Bringing the database up to what this CRM needs: the two extensions every
// project database has (made here too, for a Postgres off Task & Tool), the
// forms, booking and customers skills' tables, schema.sql, the phone
// skill's, and the payments and invoices skills' tables when quotes and
// invoices are on, through applySchema (behind the lock every app shares),
// and the configured statuses and deal
// stages on the very first run. Machine only: the service runs it at start
// and `npm run deploy` runs it before production sees new code. Never per
// request.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "../data/db";
import { applySchema } from "../data/migrate";
import type { CustomField, StageConfig } from "../config-schema";
import { publishFields } from "../crm/fields";
import { saveEveryone } from "../crm/customers";
import { leadsForOpenItems } from "../crm/leads";
import { seedStages } from "../crm/stages";

/** What the first run seeds (crm.config.json's statuses and deals.stages), and its custom fields, published on every run. */
export type Seeds = { statuses: StageConfig[]; dealStages: StageConfig[]; fields?: CustomField[] };

export const SCHEMA_FILE = fileURLToPath(new URL("../../schema.sql", import.meta.url));
export const DATA_SCHEMA_FILE = fileURLToPath(new URL("../data/schema.sql", import.meta.url));
export const CUSTOMERS_SCHEMA_FILE = fileURLToPath(new URL("../customers/schema.sql", import.meta.url));
export const BOOKING_SCHEMA_FILE = fileURLToPath(new URL("../booking/schema.sql", import.meta.url));
export const FORMS_SCHEMA_FILE = fileURLToPath(new URL("../forms/schema.sql", import.meta.url));
export const PAYMENTS_SCHEMA_FILE = fileURLToPath(new URL("../payments/schema.sql", import.meta.url));
export const INVOICES_SCHEMA_FILE = fileURLToPath(new URL("../invoices/schema.sql", import.meta.url));
export const PROPOSALS_SCHEMA_FILE = fileURLToPath(new URL("../proposals/schema.sql", import.meta.url));
export const PHONE_SCHEMA_FILE = fileURLToPath(new URL("../phone/schema.sql", import.meta.url));

export async function setup(db: Db, seeds: Seeds, opts: SetupOpts = { invoices: true, forms: true }): Promise<{ seeded: number }> {
  // On Neon the app's login may not create extensions; they are there
  // already, and IF NOT EXISTS returns before asking for the privilege.
  for (const create of [() => db.sql`create extension if not exists citext`, () => db.sql`create extension if not exists pg_trgm`]) {
    try {
      await create();
    } catch {
      // A missing extension fails loudly in applySchema below, with its name.
    }
  }
  // The business itself and the email opt-outs, which every app shares (the data skill).
  await applySchema(db, readFileSync(DATA_SCHEMA_FILE, "utf8"));
  // The forms tables, so the Forms pages work before the Website has sent anything.
  if (opts.forms !== false) await applySchema(db, readFileSync(FORMS_SCHEMA_FILE, "utf8"));
  // Booking's tables first, always: the schedule's events are bookings, and schema.sql adds the CRM's columns to them.
  await applySchema(db, readFileSync(BOOKING_SCHEMA_FILE, "utf8"));
  await applySchema(db, readFileSync(CUSTOMERS_SCHEMA_FILE, "utf8"));
  await applySchema(db, readFileSync(SCHEMA_FILE, "utf8"));
  // The business number's texts and calls (the phone skill), after the customers it adds a column to.
  await applySchema(db, readFileSync(PHONE_SCHEMA_FILE, "utf8"));
  // Invoices record their payments in the payments skill's table.
  if (opts.invoices !== false) {
    await applySchema(db, readFileSync(PAYMENTS_SCHEMA_FILE, "utf8"));
    await applySchema(db, readFileSync(INVOICES_SCHEMA_FILE, "utf8"));
    // A quote as the customer's page: its sections, link, opens and signature.
    await applySchema(db, readFileSync(PROPOSALS_SCHEMA_FILE, "utf8"));
  }
  const seeded = (await seedStages(db, "customers", seeds.statuses)) + (await seedStages(db, "deals", seeds.dealStages));
  // Then the people: the custom fields every app's savePerson fills, anyone not yet saved
  // (customers.ts saveEveryone), and a lead for each enquiry still waiting (leads.ts leadsForOpenItems).
  await publishFields(db, seeds.fields ?? []);
  await saveEveryone(db);
  await leadsForOpenItems(db);
  return { seeded };
}

type SetupOpts = { invoices?: boolean; forms?: boolean };

/** The schema files setup applies for these options, hashed: what crm_setup records. */
export function setupKey(opts: SetupOpts): string {
  const files: [string, string | false][] = [
    ["data", DATA_SCHEMA_FILE],
    ["forms", opts.forms !== false && FORMS_SCHEMA_FILE],
    ["booking", BOOKING_SCHEMA_FILE],
    ["customers", CUSTOMERS_SCHEMA_FILE],
    ["crm", SCHEMA_FILE],
    ["phone", PHONE_SCHEMA_FILE],
    ["payments", opts.invoices !== false && PAYMENTS_SCHEMA_FILE],
    ["invoices", opts.invoices !== false && INVOICES_SCHEMA_FILE],
    ["proposals", opts.invoices !== false && PROPOSALS_SCHEMA_FILE],
  ];
  const h = createHash("sha256");
  for (const [name, file] of files) if (file) h.update(name).update(readFileSync(file));
  return h.digest("hex");
}

/**
 * setup, unless the database already holds this exact schema: one read
 * instead of every schema file, for the command-line scripts. A database
 * without crm_setup, or with an older hash, gets the whole setup, and so
 * does `force` (migrate.mjs, which deploy runs, repairs as well as applies).
 */
export async function setupOnce(db: Db, seeds: Seeds, opts: SetupOpts, force = false): Promise<void> {
  const key = setupKey(opts);
  if (!force) {
    try {
      const [row] = await db.sql<{ schema_hash: string }>`select schema_hash from crm_setup where name = 'crm'`;
      if (row?.schema_hash === key) return;
    } catch {
      // No crm_setup yet: a new database, or one set up before it existed.
    }
  }
  await setup(db, seeds, opts);
  await db.sql`insert into crm_setup (name, schema_hash) values ('crm', ${key})
    on conflict (name) do update set schema_hash = excluded.schema_hash, updated_at = now()`;
}

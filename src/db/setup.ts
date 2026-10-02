// Bringing the database up to what this CRM needs: the two extensions every
// project database has (made here too, for a Postgres off Task & Tool),
// schema.sql through applySchema (additive only, safe to run by every app at
// any version, behind the lock every app shares), and the configured stages
// on the very first run. Machine only: the service runs it at start and
// `npm run deploy` runs it before production sees new code. Never per request.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "../data/db";
import { applySchema } from "../data/migrate";
import type { StageConfig } from "../config-schema";
import { seedStages } from "../crm/stages";

export const SCHEMA_FILE = fileURLToPath(new URL("../../schema.sql", import.meta.url));

export async function setup(db: Db, stages: StageConfig[]): Promise<{ seeded: number }> {
  // On Neon the app's login may not create extensions; they are there
  // already, and IF NOT EXISTS returns before asking for the privilege.
  for (const create of [() => db.sql`create extension if not exists citext`, () => db.sql`create extension if not exists pg_trgm`]) {
    try {
      await create();
    } catch {
      // A missing extension fails loudly in applySchema below, with its name.
    }
  }
  await applySchema(db, readFileSync(SCHEMA_FILE, "utf8"));
  return { seeded: await seedStages(db, stages) };
}

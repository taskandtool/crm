// Set the database up by hand (the service does this at start, and
// `npm run deploy` runs it before production sees new code): the extensions,
// schema.sql (additive only), and the configured stages on the first run.
import { done, parseArgs, plain, withDb } from "./lib";

plain(parseArgs(process.argv.slice(2)), `migrate.mjs

Applies schema.sql to the project's database (additive only, safe to run
again) and seeds the pipeline stages from crm.config.json if there are none
yet. Needs DATABASE_URL. Prints "migrate: every schema file applied".`, "migrate");
await withDb(async () => {
  done("migrate", "every schema file applied, stages seeded if there were none", { next: "node scripts/stages.mjs list" });
}, { force: true });

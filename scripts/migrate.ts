// Set the database up by hand (the service does this at start, and
// `npm run deploy` runs it before production sees new code): the extensions,
// schema.sql (additive only), and the configured stages on the first run.
import { parseArgs, withDb } from "./lib";

if (has()) {
  console.log(`migrate.mjs

Applies schema.sql to the project's database (additive only, safe to run
again) and seeds the pipeline stages from crm.config.json if there are none
yet. Needs DATABASE_URL.`);
  process.exit(0);
}
function has() {
  return parseArgs(process.argv.slice(2)).flags.help !== undefined;
}
await withDb(async () => {
  console.log("migrate: every schema file applied, stages seeded if there were none");
}, { force: true });

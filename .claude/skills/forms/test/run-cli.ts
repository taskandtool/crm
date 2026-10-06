// formsCli as an app's scripts/forms.mjs runs it, for cli.test.ts: on
// CLI_DB's database, or, without one, exiting 3 if the database is opened.
import pg from "pg";
import { fromPool } from "../../data/pg";
import { formsCli } from "../cli";

await formsCli(process.argv.slice(2), {
  source: "test",
  timeZone: "UTC",
  withDb: async (fn) => {
    if (!process.env.CLI_DB) {
      console.error("the database was opened");
      process.exit(3);
    }
    const pool = new pg.Pool({ connectionString: process.env.CLI_DB, max: 2 });
    try {
      return await fn(fromPool(pool));
    } finally {
      await pool.end();
    }
  },
});

// quotesCli or invoicesCli (the first argument) as an app's scripts run them,
// for cli.test.ts: on CLI_DB's database, or, without one, exiting 3 if the
// database is opened.
import pg from "pg";
import { fromPool } from "../../data/pg";
import { invoicesCli, quotesCli } from "../cli";

const [which, ...argv] = process.argv.slice(2);
await (which === "quotes" ? quotesCli : invoicesCli)(argv, {
  business: "Acme",
  currency: "usd",
  timeZone: "UTC",
  source: "test",
  env: {},
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

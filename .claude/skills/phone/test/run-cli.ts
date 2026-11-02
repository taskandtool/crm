// phoneCli as an app's scripts/phone.mjs runs it, for cli.test.ts: it exits
// 3 if the database is opened, so a test proves misuse is refused before.
import { phoneCli } from "../cli";

await phoneCli(process.argv.slice(2), {
  timeZone: "UTC",
  ctx: () => {
    throw new Error("unreachable: the database is never opened here");
  },
  withDb: async () => {
    console.error("the database was opened");
    process.exit(3);
  },
});

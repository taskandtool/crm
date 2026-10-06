// Forms from chat: the forms skill's command (src/forms/cli.ts) with this
// CRM's database and zone. `--help` for usage.
import { formsCli } from "../src/forms/cli";
import { cfg } from "../src/config";
import { withDb } from "./lib";

await formsCli(process.argv.slice(2), { withDb: (fn) => withDb((db) => fn(db)), source: "crm", timeZone: cfg.time_zone });

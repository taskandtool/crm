// The business number from chat: the phone skill's command (src/phone/cli.ts)
// with this CRM's database, zone and phone context. `--help` for usage.
import { phoneCli } from "../src/phone/cli";
import { cfg } from "../src/config";
import { jobCtx } from "../src/crm/texting";
import { machineEnv } from "../src/data/cli.mjs";
import { production } from "../src/proposals/serving";
import { withDb } from "./lib";

await phoneCli(process.argv.slice(2), { withDb: (fn) => withDb((db) => fn(db)), ctx: (db) => jobCtx(db, machineEnv(), production), timeZone: cfg.time_zone });

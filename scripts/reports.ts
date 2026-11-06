// The lead report from chat: the reports skill's command with this CRM's database, zone and currency. `--help` for usage.
import { cfg, dealsCfg } from "../src/config";
import { reportsCli } from "../src/reports/cli";
import { withDb } from "./lib";

await reportsCli(process.argv.slice(2), { withDb, zone: cfg.time_zone, currency: dealsCfg.currency, who: process.env.CRM_USER });

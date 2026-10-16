// MACHINE ONLY. The "Recurring invoices" scheduled job: every recurring
// invoice's due periods made as ordinary invoices, and drafted, sent or
// charged as each one says (the invoices skill's recurring.ts). Never import
// this from a page.
//
//   npx tsx src/crm/recurring-job.ts
//
// Schedule it once a day, at the UTC hour that is 06:00 in the business's
// zone. Its hour never decides a date: today is the business's date, and a
// run that is late or missed is caught up by the next one. Exits 1 when an
// invoice could not be made, sent or charged (each has a task too).
import { cfg } from "../config";
import { checkFlags, fail, has, machineEnv, misused, parseArgs } from "../data/cli.mjs";
import { fromPool, openPool } from "../data/pg";
import { todayIn } from "../invoices/document";
import { runRecurring } from "../invoices/recurring";
import { stripeFrom } from "../payments/stripe";
import { recurringTask } from "./recurring";

const CMD = "npx tsx src/crm/recurring-job.ts";
const USAGE = `usage: ${CMD}

Makes today's recurring invoices (and any missed ones) in ${cfg.time_zone}:
a draft with a task, emailed to pay, or charged to the card on file, as
each recurring invoice says. One more than 2 days late waits as a draft.
Safe to run again: a period is made once.

  --help, -h   this text

Prints "recurring invoices: N made (...)", then any failure on stderr.
Exit 1 when one could not be made, sent or charged; 2 when misused.`;

const a = parseArgs(process.argv.slice(2));
if (has(a, "help")) {
  console.log(USAGE);
  process.exit(0);
}
checkFlags(a, [], "recurring invoices", `${CMD} --help`);
if (a._.length) misused(`recurring invoices: unexpected ${a._.join(" ")}; it takes no arguments`, CMD);

const env = machineEnv();
if (!env.DATABASE_URL) fail("recurring invoices: DATABASE_URL is not set, so there is no database to read", `run it on the machine as a scheduled job: ${CMD}`);

const pool = openPool(env.DATABASE_URL, 2);
try {
  const db = fromPool(pool);
  const r = await runRecurring(db, { today: todayIn(cfg.time_zone), timeZone: cfg.time_zone, stripe: () => stripeFrom(env), task: recurringTask(db) });
  const parts = [
    r.drafts && `${r.drafts} draft${r.drafts === 1 ? "" : "s"}`, r.sent && `${r.sent} sent`, r.charged && `${r.charged} charged`,
    r.emailed && `${r.emailed} emailed (no card on file)`, r.failed && `${r.failed} failed`, r.ended && `${r.ended} ended`,
  ].filter(Boolean);
  console.log(r.made || r.failed || r.ended ? `recurring invoices: ${r.made} made${parts.length ? ` (${parts.join(", ")})` : ""}` : "recurring invoices: none due today");
  for (const e of r.errors) console.error(`  ${e}`);
  process.exitCode = r.failed ? 1 : 0;
} finally {
  await pool.end();
}

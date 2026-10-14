// MACHINE ONLY. The morning email's command; the email itself is digest.ts,
// which is edge-safe. Never import this from a page.
//
//   npx tsx src/crm/digest-job.ts              # at or after 7:00 in the business's zone
//   npx tsx src/crm/digest-job.ts --hour 8
//
// Schedule it every hour: before the hour it does nothing, after it each
// person with tasks due gets one email that day. One run; exits 1 when
// a send failed, so the job's run history shows why.
import pg from "pg";
import { cfg, invoicesCfg } from "../config";
import { emailSend } from "../booking/notify";
import { checkFlags, fail, flag, has, machineEnv, misused, parseArgs } from "../data/cli.mjs";
import { fromPool } from "../data/pg";
import { DEFAULT_HOUR, sendDigests } from "./digest";

const CMD = "npx tsx src/crm/digest-job.ts";
const USAGE = `usage: ${CMD} [--hour H]

Emails each team member their tasks due (overdue and today), once a
day, through the owner's email sender.

  --hour H     the hour it goes, 0 to 23, in ${cfg.time_zone} (default ${DEFAULT_HOUR})
  --help, -h   this text

Prints "task emails: N sent" (or none due, or not yet), then any failure
on stderr. Exit 1 when a send failed, 2 when misused.`;

const a = parseArgs(process.argv.slice(2));
if (has(a, "help")) {
  console.log(USAGE);
  process.exit(0);
}
checkFlags(a, ["hour"], "task emails", `${CMD} --help`);
if (a._.length) misused(`task emails: unexpected ${a._.join(" ")}; the only option is --hour`, `${CMD} --hour ${DEFAULT_HOUR}`);
let hour = DEFAULT_HOUR;
if (has(a, "hour")) {
  const v = flag(a, "hour") ?? "";
  if (!/^\d{1,2}$/.test(v) || Number(v) > 23) misused(`task emails: --hour ${v} is not a whole hour from 0 to 23`, `${CMD} --hour ${DEFAULT_HOUR}`);
  hour = Number(v);
}

const env = machineEnv();
if (!env.DATABASE_URL) fail("task emails: DATABASE_URL is not set, so there is no database to read", `run it on the machine as a scheduled job: ${CMD}`);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
try {
  const r = await sendDigests(fromPool(pool), emailSend(env), { timeZone: cfg.time_zone, hour, word: invoicesCfg?.word });
  const parts = [`${r.sent} sent`];
  if (r.none) parts.push(`${r.none} not sent (no email sender connected; recorded, not retried)`);
  if (r.failed) parts.push(`${r.failed} failed (not retried today)`);
  console.log(
    r.early ? `task emails: not yet (they go at ${hour}:00 ${cfg.time_zone})`
      : r.sent || r.none || r.failed ? `task emails: ${parts.join(", ")}`
      : "task emails: none due (nobody with an email has tasks due, or today's went already)",
  );
  for (const e of r.errors) console.error(`  ${e}`);
  process.exitCode = r.failed ? 1 : 0;
} finally {
  await pool.end();
}

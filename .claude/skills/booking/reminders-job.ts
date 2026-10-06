// MACHINE ONLY. The reminder job's command; the reminders themselves are
// reminders.ts, which is edge-safe. Never import this from a page.
//
//   npx tsx src/booking/reminders-job.ts                  # a day and an hour before
//   npx tsx src/booking/reminders-job.ts --before 1440,120
//
// Schedule it every 15 minutes (the platform's floor), so an hour's
// reminder goes 45 to 60 minutes before. One run; exits 1 when a send
// failed, so the job's run history shows why.
import pg from "pg";
import { checkFlags, fail, flag, flags, has, machineEnv, misused, parseArgs } from "../data/cli.mjs";
import { fromPool } from "../data/pg";
import { emailSend } from "./notify";
import { releaseLapsedHolds } from "./book";
import { DEFAULT_BEFORE, sendReminders } from "./reminders";

const CMD = "npx tsx src/booking/reminders-job.ts";
const USAGE = `usage: ${CMD} [--before MINUTES,...]

Sends each booker the reminders due now, once each, through the owner's email sender.

  --before M,M   minutes before the start, each 1 to 10080 (default ${DEFAULT_BEFORE.join(",")}: a day and an hour)
  --help, -h     this text

Prints "booking reminders: N sent" (or none due), then any failure on stderr.
Exit 1 when a send failed, 2 when misused.`;
const TRY = `${CMD} --before ${DEFAULT_BEFORE.join(",")}`;

const a = parseArgs(process.argv.slice(2));
if (has(a, "help")) {
  console.log(USAGE);
  process.exit(0);
}
checkFlags(a, ["before"], "booking reminders", `${CMD} --help`);
if (a._.length) misused(`booking reminders: unexpected ${a._.join(" ")}; the only option is --before`, TRY);
let before = DEFAULT_BEFORE;
if (has(a, "before")) {
  if (flags(a, "before").length > 1) misused("booking reminders: give --before once, with every minute in it", TRY);
  const value = flag(a, "before");
  if (!value) misused("booking reminders: --before needs minutes, comma-separated", TRY);
  const parts = value.split(",");
  const bad = parts.filter((m) => !/^\s*\d+\s*$/.test(m) || Number(m) < 1 || Number(m) > 10080);
  if (bad.length) misused(`booking reminders: --before ${value}: ${bad.map((b) => `"${b}"`).join(", ")} ${bad.length > 1 ? "are" : "is"} not whole minutes from 1 to 10080`, TRY);
  before = parts.map(Number);
}

// The machine's settings (the sender, DATABASE_URL), so a run by hand from a
// chat shell sees what the scheduled job sees.
const env = machineEnv();
if (!env.DATABASE_URL) fail("booking reminders: DATABASE_URL is not set, so there is no database to read", `run it on the machine as a scheduled job: ${CMD}`);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
try {
  const db = fromPool(pool);
  // Times held for a payment that never came are freed first, so nobody is reminded of them.
  const released = await releaseLapsedHolds(db);
  if (released) console.log(`booking holds: ${released} whose form was not finished in time, cancelled`);
  const r = await sendReminders(db, emailSend(env), { before });
  const parts = [`${r.sent} sent`];
  if (r.none) parts.push(`${r.none} not sent (no email sender connected; recorded, not retried)`);
  if (r.failed) parts.push(`${r.failed} failed (not retried)`);
  console.log(r.sent || r.none || r.failed ? `booking reminders: ${parts.join(", ")}` : `booking reminders: none due (${before.join(", ")} minutes before)`);
  for (const e of r.errors) console.error(`  ${e}`);
  process.exitCode = r.failed ? 1 : 0;
} finally {
  await pool.end();
}

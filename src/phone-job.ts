// MACHINE ONLY. The automatic texts' job, every 15 minutes (the platform's
// floor): what time brings (a form left before booking, a visit coming up,
// a visit done), every text or email that is due, and the texting
// registration checked once an hour until Twilio approves it (phone/job.ts).
// Scheduled at install (.taskandtool/setup.sh); without Twilio it still
// sends the follow-ups that can go by email.
//
//   npx tsx src/phone-job.ts
//
// Prints what it did; exits 1 when a send failed, so the job's run history shows why.
import { checkFlags, fail, has, machineEnv, parseArgs } from "./data/cli.mjs";
import { fromPool, openPool } from "./data/pg";
import { jobCtx } from "./crm/texting";
import { phoneJob } from "./phone/job";
import { production } from "./proposals/serving";

const CMD = "npx tsx src/phone-job.ts";
const a = parseArgs(process.argv.slice(2));
if (has(a, "help")) {
  console.log(`usage: ${CMD}\n\nSends the automatic texts that are due (by email where a text can't go) and checks the texting registration.\nPrints what it did. Exit 1 when a send failed.`);
  process.exit(0);
}
checkFlags(a, [], "phone job", `${CMD} --help`);
const env = machineEnv();
if (!env.DATABASE_URL) fail("phone job: DATABASE_URL is not set, so there is no database to read", `run it on the machine as a scheduled job: ${CMD}`);

const pool = openPool(env.DATABASE_URL, 2);
try {
  const db = fromPool(pool);
  const r = await phoneJob(await jobCtx(db, env, production));
  const parts = [`${r.sent} sent`];
  if (r.scheduled) parts.push(`${r.scheduled} newly due`);
  if (r.later) parts.push(`${r.later} waiting (quiet hours, or a visit still ahead)`);
  if (r.skipped) parts.push(`${r.skipped} not sent (the reason is on each)`);
  if (r.failed) parts.push(`${r.failed} failed`);
  console.log(`automatic texts: ${parts.join(", ")}`);
  if (r.registration) console.log(r.registration);
  process.exitCode = r.failed ? 1 : 0;
} catch (e) {
  fail(`phone job: ${(e instanceof Error && (e.message || (e as { code?: string }).code)) || String(e)}`, `${CMD}, once the database answers`);
} finally {
  await pool.end();
}

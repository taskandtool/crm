// The morning email: each team member with tasks due, or a proposal of
// theirs first opened since yesterday, gets one message, at or after `hour`
// in the business's zone, listing what is overdue and what is due today
// (with the follow-ups proposals about to expire unsigned get), the
// proposals opened, and how many leads came in since yesterday. Through a `Send`
// (booking/notify.ts) as team mail: Task & Tool email reaches whoever can open
// the CRM, Resend or Postmark anyone.
// Edge-safe; the job's command is digest-job.ts (machine only).
//
// Each person's email is claimed in follow_up_digests (email, day) before it
// is sent, so a job run every hour sends it once a day, and a failed send is
// recorded, not retried into a flood. An owner written as an email gets one,
// and so does a team member written by name (their email from the team list);
// any other name has nobody to mail.
import { q, type Db } from "../data/db";
import type { Send } from "../booking/notify";
import { todayIn } from "../reports/sql";
import { TASK_LABELS, type TaskKind } from "./tasks";
import { present } from "./tables";
import { nowIn } from "./text";
import { openedSince, proposalFollowUps, type Opened } from "../proposals/followup";

export const DEFAULT_HOUR = 7;

export type DigestRun = { sent: number; none: number; failed: number; errors: string[]; early: boolean };

type Due = { owner: string; kind: TaskKind; title: string; due_on: string; due_time: string | null; customer_name: string; customer_phone: string | null };

/** Send every morning email due now. */
export async function sendDigests(db: Db, send: Send, opts: { timeZone: string; hour?: number; now?: Date; word?: string }): Promise<DigestRun> {
  const now = opts.now ?? new Date();
  const run: DigestRun = { sent: 0, none: 0, failed: 0, errors: [], early: false };
  if (Number(nowIn(opts.timeZone, now).slice(11, 13)) < (opts.hour ?? DEFAULT_HOUR)) return { ...run, early: true };
  const today = todayIn(opts.timeZone, now);
  // A proposal about to expire unsigned is a task for today, in the list below.
  await proposalFollowUps(db, today, opts.word ?? "Quote");
  // A task written to a team member by name goes to the email the team list has for them.
  const emailOf = new Map(
    (await db.sql<{ name: string; email: string }>`select name, email::text as email from resources where email is not null order by active, id`).map((r) => [r.name.toLowerCase(), r.email]),
  );
  const due = (await db.sql<Due>`
    select f.owner::text as owner, f.kind, f.title, to_char(f.due_on, 'YYYY-MM-DD') as due_on, to_char(f.due_time, 'HH24:MI') as due_time,
           c.name as customer_name, c.phone as customer_phone
    from follow_ups f join customers c on c.id = f.customer_id
    where f.done_at is null and c.archived_at is null and f.due_on <= ${today}::date and f.owner is not null
    order by f.due_on, f.due_time nulls last, f.id`)
    .map((d) => ({ ...d, owner: emailOf.get(d.owner.toLowerCase()) ?? d.owner }))
    .filter((d) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.owner));
  const opened = (await openedSince(db, new Date(now.getTime() - 86_400_000))).filter((o) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.owner));
  if (!due.length && !opened.length) return run;
  const leads = (await present(db)).submissions
    ? (await db.sql<{ n: number }>`select count(*)::int as n from submissions where status is distinct from 'spam' and created_at >= ${now.toISOString()}::timestamptz - interval '1 day'`)[0].n
    : null;
  const byOwner = new Map<string, Due[]>();
  for (const d of due) byOwner.set(d.owner.toLowerCase(), [...(byOwner.get(d.owner.toLowerCase()) ?? []), d]);
  for (const o of opened) if (!byOwner.has(o.owner.toLowerCase())) byOwner.set(o.owner.toLowerCase(), []);
  for (const [email, items] of byOwner) {
    const [claimed] = await db.transaction([
      q`insert into follow_up_digests (email, day) values (${email}, ${today}::date) on conflict do nothing returning email`,
    ]);
    if (!claimed.length) continue;
    const sent = await send(digestMessage(email, items, today, leads, opened.filter((o) => o.owner.toLowerCase() === email), opts.word));
    const status = sent.status;
    run[status === "sent" ? "sent" : status === "none" ? "none" : "failed"]++;
    const detail = sent.status === "sent" ? sent.via : sent.status === "none" ? sent.why : sent.error;
    if (sent.status === "failed") run.errors.push(`${email}: ${sent.error}`);
    await db.sql`update follow_up_digests set status = ${status}, detail = ${detail.slice(0, 500)}, updated_at = now() where email = ${email} and day = ${today}::date`;
  }
  return run;
}

/** One person's morning email: overdue first, then today, then their proposals opened, then the leads line. */
export function digestMessage(to: string, items: Due[], today: string, leads: number | null, opened: Opened[] = [], word = "Quote") {
  const overdue = items.filter((i) => i.due_on < today);
  const todays = items.filter((i) => i.due_on === today);
  const line = (i: Due) =>
    `- ${TASK_LABELS[i.kind]}: ${i.title} (${i.customer_name}${i.kind === "call" && i.customer_phone ? `, ${i.customer_phone}` : ""})` +
    (i.due_on < today ? `, due ${i.due_on}` : i.due_time ? `, ${i.due_time}` : "");
  const w = word.toLowerCase();
  const subject = overdue.length && todays.length
    ? `${overdue.length} overdue and ${todays.length} due today`
    : overdue.length ? `${overdue.length} task${overdue.length === 1 ? "" : "s"} overdue`
    : todays.length ? `${todays.length} task${todays.length === 1 ? "" : "s"} due today`
    : `${opened.length} ${w}${opened.length === 1 ? "" : "s"} opened, not signed yet`;
  const text = [
    "Good morning. Here is what is due in the CRM.",
    ...(overdue.length ? ["", "Overdue", ...overdue.map(line)] : []),
    ...(todays.length ? ["", "Today", ...todays.map(line)] : []),
    ...(opened.length ? ["", `Opened, not signed yet`, ...opened.map((o) => `- ${word} ${o.number} (${o.name})`)] : []),
    ...(leads ? ["", `${leads} new lead${leads === 1 ? "" : "s"} came in since yesterday.`] : []),
    "",
    "Tick them off on the CRM's Tasks page.",
  ].join("\n");
  return { to, subject, text, team: true };
}

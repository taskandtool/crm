// What the morning brings about proposals (crm/digest.ts runs these):
// a task to follow up on one about to expire unsigned, and the ones
// customers first opened in the last day, for whoever made each. Nothing
// here reaches a customer. Edge-safe.
import type { Db } from "../data/db";
import { addTask } from "../crm/tasks";
import { findMatch } from "../crm/customers";

/** Days before valid_until that an unsigned proposal gets its follow-up task. */
const FOLLOW_UP_DAYS = 3;

const hasProposals = async (db: Db) => (await db.sql`select to_regclass('quote_proposals') is not null as yes`)[0].yes === true;

/**
 * "Follow up with Acme on Q-0012", due today for whoever made the quote, once
 * per quote: a sent one with a link, open until FOLLOW_UP_DAYS from today or
 * sooner, and not answered.
 */
export async function proposalFollowUps(db: Db, today: string, word: string): Promise<number> {
  if (!(await hasProposals(db))) return 0;
  const due = await db.sql`
    update quote_proposals p set followed_up_at = now()
    from quotes q
    where q.id = p.quote_id and q.status = 'sent' and p.link_made_at is not null and p.followed_up_at is null
      and q.valid_until is not null and q.valid_until >= ${today}::date and q.valid_until <= ${today}::date + ${FOLLOW_UP_DAYS}::int
    returning q.id::text as id, q.number, q.email::text as email, q.phone, q.name, q.created_by::text as owner, q.deal_id::text as deal_id,
              to_char(q.valid_until, 'YYYY-MM-DD') as until`;
  let made = 0;
  for (const q of due) {
    const customer = await findMatch(db, q.email, q.phone);
    if (!customer) continue;
    const t = await addTask(db, customer.id, {
      kind: "task", title: `Follow up with ${q.name ?? q.email} on ${word.toLowerCase()} ${q.number}: open until ${q.until}, not signed yet`,
      due_on: today, due_time: null, owner: q.owner, deal_id: q.deal_id,
    }, "CRM");
    if (t) made++;
  }
  return made;
}

export type Opened = { owner: string; number: string; name: string; at: Date };

/** Proposals a customer first opened since `since`, not yet answered, by who made them. */
export async function openedSince(db: Db, since: Date): Promise<Opened[]> {
  if (!(await hasProposals(db))) return [];
  const rows = await db.sql`
    select q.created_by::text as owner, q.number, coalesce(q.name, q.email::text) as name, q.viewed_at as at
    from quotes q
    where q.status = 'sent' and q.viewed_at >= ${since.toISOString()}::timestamptz and q.created_by is not null
    order by q.viewed_at`;
  return rows.map((r) => ({ owner: r.owner, number: r.number, name: r.name, at: new Date(r.at) }));
}

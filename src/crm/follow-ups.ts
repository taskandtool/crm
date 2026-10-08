// Follow-ups: the next thing to do for a customer, and the deal it is for,
// if any. A call, email, meeting, text or task, due on a day in the
// business's zone (a date, so "today" and "overdue" never cross a DST
// boundary), at a time or any time that day, by one person. Ticking one off
// writes it on the customer's timeline as a note of the same kind, so a call
// done moves their last contact as any call does. Never deleted.
//
// "Nothing planned" is everyone in play (an open status, or an open deal)
// with no open follow-up and no visit planned from today on: the list
// nobody should be on for long, quietest first.
import { q, type Db } from "../data/db";
import { addDays } from "../reports/sql";

export { addDays };

export const FOLLOW_UP_KINDS = ["call", "email", "meeting", "text", "task"] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number];
export const FOLLOW_UP_LABELS: Record<FollowUpKind, string> = { call: "Call", email: "Email", meeting: "Meeting", text: "Text", task: "To do" };
export const pickFollowUpKind = (v: unknown): FollowUpKind | null => (FOLLOW_UP_KINDS.includes(v as FollowUpKind) ? (v as FollowUpKind) : null);

export type FollowUp = {
  id: string;
  customer_id: string;
  deal_id: string | null;
  kind: FollowUpKind;
  title: string;
  /** YYYY-MM-DD in the business's zone. */
  due_on: string;
  /** HH:MM, or null for any time that day. */
  due_time: string | null;
  owner: string | null;
  done_at: Date | null;
  done_by: string | null;
  created_by: string | null;
  created_at: Date;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  deal_title: string | null;
};

export type FollowUpInput = {
  kind: FollowUpKind;
  title: string;
  due_on: string;
  due_time: string | null;
  owner: string | null;
  deal_id: string | null;
};

/** The views of the list. */
export const FOLLOW_UP_VIEWS = ["due", "upcoming", "none"] as const;
export type FollowUpView = (typeof FOLLOW_UP_VIEWS)[number];
export const UPCOMING_DAYS = 14;

const ID = /^\d{1,18}$/;
export const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A day as YYYY-MM-DD, or null when it is not a real one ("2026-02-30" is not). */
export function readDay(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!DAY.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s) ? s : null;
}

/** A time as HH:MM ("9:30" and "09:30:00" read too), or null. */
export function readTime(v: unknown): string | null {
  const m = (typeof v === "string" ? v.trim() : "").match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const t = `${m[1].padStart(2, "0")}:${m[2]}`;
  return TIME.test(t) ? t : null;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * A day said the way the owner says it, from `today` (YYYY-MM-DD in the
 * business's zone): "2026-10-09", "today", "tomorrow", "friday" or "next
 * friday" (the coming one, never today), "in 3 days", "in 2 weeks". Null for
 * anything else.
 */
export function relativeDay(v: unknown, today: string): string | null {
  const s = (typeof v === "string" ? v : "").trim().toLowerCase();
  const exact = readDay(s);
  if (exact) return exact;
  if (s === "today") return today;
  if (s === "tomorrow") return addDays(today, 1);
  const wd = s.match(/^(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (wd) {
    const now = new Date(today + "T12:00:00Z").getUTCDay();
    return addDays(today, ((WEEKDAYS.indexOf(wd[1]) - now + 7) % 7) || 7);
  }
  const n = s.match(/^in\s+(\d{1,3})\s+(day|days|week|weeks)$/);
  if (n) return addDays(today, Number(n[1]) * (n[2].startsWith("week") ? 7 : 1));
  return null;
}


const SELECT = `f.id::text as id, f.customer_id::text as customer_id, f.deal_id::text as deal_id, f.kind, f.title,
  to_char(f.due_on, 'YYYY-MM-DD') as due_on, to_char(f.due_time, 'HH24:MI') as due_time, f.owner::text as owner,
  f.done_at, f.done_by::text as done_by, f.created_by::text as created_by, f.created_at,
  c.name as customer_name, c.phone as customer_phone, c.email::text as customer_email, d.title as deal_title`;
const FROM = `from follow_ups f join customers c on c.id = f.customer_id left join deals d on d.id = f.deal_id`;

// SELECT and FROM are fixed texts of this file, spliced into each statement's
// text; values stay parameters.
function withCols(strings: TemplateStringsArray): TemplateStringsArray {
  const out = strings.map((s) => s.replaceAll("{select}", SELECT).replaceAll("{from}", FROM));
  return Object.assign(out, { raw: out });
}
const sql = <T extends Record<string, any>>(db: Db) => (strings: TemplateStringsArray, ...values: unknown[]) => db.sql<T>(withCols(strings), ...values);

export async function getFollowUp(db: Db, id: string): Promise<FollowUp | null> {
  if (!ID.test(id)) return null;
  const [f] = await sql<FollowUp>(db)`select {select} {from} where f.id = ${id}::bigint`;
  return f ?? null;
}

/**
 * Add one for a customer. A deal named must be theirs, or it is left off.
 * Null when the customer does not exist.
 */
export async function addFollowUp(db: Db, customerId: string, f: FollowUpInput, user: string): Promise<FollowUp | null> {
  if (!ID.test(customerId)) return null;
  const deal = f.deal_id && ID.test(f.deal_id) ? f.deal_id : null;
  const [made] = await db.sql<{ id: string }>`
    insert into follow_ups (customer_id, deal_id, kind, title, due_on, due_time, owner, created_by, updated_by)
    select c.id, (select d.id from deals d where d.id = ${deal}::bigint and d.customer_id = c.id),
           ${f.kind}, ${f.title}, ${f.due_on}::date, ${f.due_time}::time, ${f.owner}::citext, ${user}, ${user}
    from customers c where c.id = ${customerId}::bigint
    returning id::text as id`;
  return made ? getFollowUp(db, made.id) : null;
}

/**
 * Tick one off: once, by whoever did it. It goes on the customer's timeline
 * as a note of its kind (a task as a plain note) with what came of it, and a
 * call, email, meeting or text moves their last contact. Null when it does
 * not exist; `already` when it was done before.
 */
export async function doneFollowUp(db: Db, id: string, outcome: string | null, user: string): Promise<{ followUp: FollowUp; already: boolean } | null> {
  if (!ID.test(id)) return null;
  const said = (outcome ?? "").trim().slice(0, 10_000);
  const [done] = await db.transaction([
    q`with d as (
        update follow_ups set done_at = now(), done_by = ${user}, updated_at = now(), updated_by = ${user}
        where id = ${id}::bigint and done_at is null
        returning customer_id, kind, title)
      insert into customer_notes (customer_id, kind, body, author, happened_at)
      select d.customer_id, case when d.kind = 'task' then 'note' else d.kind end,
             d.title || case when ${said}::text <> '' then E'\\n' || ${said}::text else '' end, ${user}, now()
      from d
      returning customer_id`,
    // notes.ts's rule: the latest call, email, meeting or text noted.
    q`update customers c set
        last_contact_at = greatest(c.last_contact_at, (select max(n.happened_at) from customer_notes n where n.customer_id = c.id and n.kind <> 'note')),
        updated_at = now(), updated_by = ${user}
      where c.id = (select customer_id from follow_ups where id = ${id}::bigint)
        and c.last_contact_at is distinct from greatest(c.last_contact_at, (select max(n.happened_at) from customer_notes n where n.customer_id = c.id and n.kind <> 'note'))`,
  ]);
  const f = await getFollowUp(db, id);
  return f ? { followUp: f, already: done.length === 0 } : null;
}

/** Move an open one to another day (and time, when given; null for any time). False when it is done or missing. */
export async function moveFollowUp(db: Db, id: string, dueOn: string, dueTime: string | null | undefined, user: string): Promise<boolean> {
  if (!ID.test(id)) return false;
  const keep = dueTime === undefined;
  const rows = await db.sql`
    update follow_ups set due_on = ${dueOn}::date,
      due_time = case when ${keep}::boolean then due_time else ${dueTime ?? null}::time end,
      updated_at = now(), updated_by = ${user}
    where id = ${id}::bigint and done_at is null
    returning id`;
  return rows.length > 0;
}

/**
 * The open ones in a view, soonest first: due (today and every day before
 * it, so nothing overdue hides) or upcoming (the next UPCOMING_DAYS days).
 * `owner` narrows to one person's; `limit` and one more.
 */
export async function listFollowUps(db: Db, view: Exclude<FollowUpView, "none">, today: string, owner: string | null, limit = 100): Promise<FollowUp[]> {
  const until = addDays(today, UPCOMING_DAYS);
  return sql<FollowUp>(db)`
    select {select} {from}
    where f.done_at is null and c.archived_at is null
      and (${owner}::text is null or f.owner = ${owner}::citext)
      and case ${view}::text
            when 'due' then f.due_on <= ${today}::date
            else f.due_on > ${today}::date and f.due_on <= ${until}::date end
    order by f.due_on, f.due_time nulls last, f.id
    limit ${limit + 1}`;
}

/** How many are overdue and due today: everyone's, or one person's. */
export async function followUpCounts(db: Db, today: string, owner: string | null): Promise<{ overdue: number; today: number }> {
  const [r] = await db.sql<{ overdue: number; today: number }>`
    select count(*) filter (where f.due_on < ${today}::date)::int as overdue,
           count(*) filter (where f.due_on = ${today}::date)::int as today
    from follow_ups f join customers c on c.id = f.customer_id
    where f.done_at is null and c.archived_at is null and f.due_on <= ${today}::date
      and (${owner}::text is null or f.owner = ${owner}::citext)`;
  return r;
}

/** A customer's open ones, soonest first, and the last few done. */
export async function customerFollowUps(db: Db, customerId: string): Promise<{ open: FollowUp[]; done: FollowUp[] }> {
  if (!ID.test(customerId)) return { open: [], done: [] };
  const [open, done] = await Promise.all([
    sql<FollowUp>(db)`select {select} {from} where f.customer_id = ${customerId}::bigint and f.done_at is null order by f.due_on, f.due_time nulls last, f.id`,
    sql<FollowUp>(db)`select {select} {from} where f.customer_id = ${customerId}::bigint and f.done_at is not null order by f.done_at desc, f.id desc limit 5`,
  ]);
  return { open, done };
}

/** Each customer's next open one: what a pipeline card and a list row mark. */
export async function nextFollowUps(db: Db, customerIds: string[]): Promise<Map<string, { due_on: string; due_time: string | null }>> {
  const ids = customerIds.filter((x) => ID.test(x));
  if (!ids.length) return new Map();
  const rows = await db.sql<{ customer_id: string; due_on: string; due_time: string | null }>`
    select distinct on (customer_id) customer_id::text as customer_id, to_char(due_on, 'YYYY-MM-DD') as due_on, to_char(due_time, 'HH24:MI') as due_time
    from follow_ups where done_at is null and customer_id = any(${ids}::bigint[])
    order by customer_id, due_on, due_time nulls last, id`;
  return new Map(rows.map((r) => [r.customer_id, { due_on: r.due_on, due_time: r.due_time }]));
}

/** When the next one is, against today: what the mark on a card says. */
export type Due = "overdue" | "today" | "later" | "none";
export function dueOf(next: { due_on: string } | undefined, today: string): Due {
  if (!next) return "none";
  return next.due_on < today ? "overdue" : next.due_on === today ? "today" : "later";
}

export type Unplanned = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  owner: string | null;
  quiet_days: number;
  /** False while nobody has been in touch: quiet_days then counts from when they were added. */
  contacted: boolean;
  /** Their open deals' titles, if any. */
  deals: string[];
};

/**
 * Everyone in play with nothing planned: an open status or an open deal, no
 * open follow-up, no visit planned from today on. Quietest first (their last
 * contact, or when they were added). `owner` narrows to the customers one
 * person looks after, or whose open deal they own.
 */
export async function nothingPlanned(db: Db, owner: string | null, limit = 100): Promise<Unplanned[]> {
  return db.sql<Unplanned>`
    select c.id::text as id, c.name, c.phone, c.email::text as email, c.owner::text as owner,
           extract(day from now() - coalesce(c.last_contact_at, c.created_at))::int as quiet_days,
           c.last_contact_at is not null as contacted,
           coalesce((select array_agg(d.title order by d.created_at) from deals d join deal_stages s on s.key = d.stage
                     where d.customer_id = c.id and d.archived_at is null and s.kind = 'open'), '{}') as deals
    from customers c
    where c.archived_at is null
      and (exists (select 1 from pipeline_stages s where s.key = c.stage and s.kind = 'open')
           or exists (select 1 from deals d join deal_stages s on s.key = d.stage where d.customer_id = c.id and d.archived_at is null and s.kind = 'open'))
      and not exists (select 1 from follow_ups f where f.customer_id = c.id and f.done_at is null)
      and not exists (select 1 from customer_visits v where v.customer_id = c.id and v.status = 'planned' and v.starts_at >= now())
      and (${owner}::text is null or c.owner = ${owner}::citext
           or exists (select 1 from deals d join deal_stages s on s.key = d.stage
                      where d.customer_id = c.id and d.archived_at is null and s.kind = 'open' and d.owner = ${owner}::citext))
    order by coalesce(c.last_contact_at, c.created_at), c.id
    limit ${limit + 1}`;
}

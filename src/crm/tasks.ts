// Tasks: the next thing to do for a customer, and the deal it is for,
// if any. A call, email, meeting, text or to-do, due on a day in the
// business's zone (a date, so "today" and "overdue" never cross a DST
// boundary), at a time or any time that day, by one person. Ticking one off
// writes it on the customer's timeline as a note of the same kind, so a call
// done moves their last contact as any call does. Never deleted.
//
// "Nothing planned" is everyone in play (an open status, or an open deal)
// with no open task and no event scheduled from today on: the list
// nobody should be on for long, quietest first.
import { q, type Db } from "../data/db";
import { sameAs } from "./people";
import { byEmail, EVENT_OF, NOTHING_PLANNED, spliced } from "./sql";
import { present as presentTables } from "./tables";
import { addDays } from "../reports/sql";

export { addDays };

export const TASK_KINDS = ["call", "email", "meeting", "text", "task"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_LABELS: Record<TaskKind, string> = { call: "Call", email: "Email", meeting: "Meeting", text: "Text", task: "To do" };
export const pickTaskKind = (v: unknown): TaskKind | null => (TASK_KINDS.includes(v as TaskKind) ? (v as TaskKind) : null);

export type Task = {
  id: string;
  customer_id: string;
  deal_id: string | null;
  kind: TaskKind;
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

export type TaskInput = {
  kind: TaskKind;
  title: string;
  due_on: string;
  due_time: string | null;
  owner: string | null;
  deal_id: string | null;
};


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


const SELECT = `t.id::text as id, t.customer_id::text as customer_id, t.deal_id::text as deal_id, t.kind, t.title,
  to_char(t.due_on, 'YYYY-MM-DD') as due_on, to_char(t.due_time, 'HH24:MI') as due_time, t.owner::text as owner,
  t.done_at, t.done_by::text as done_by, t.created_by::text as created_by, t.created_at,
  c.name as customer_name, c.phone as customer_phone, c.email::text as customer_email, d.title as deal_title`;
const FROM = `from follow_ups t join customers c on c.id = t.customer_id left join deals d on d.id = t.deal_id`;

const { sql } = spliced({ select: SELECT, from: FROM, nothing_planned: NOTHING_PLANNED });

export async function getTask(db: Db, id: string): Promise<Task | null> {
  if (!ID.test(id)) return null;
  const [task] = await sql(db)<Task>`select {select} {from} where t.id = ${id}::bigint`;
  return task ?? null;
}

/**
 * Add one for a customer. A deal named must be theirs, or it is left off.
 * Null when the customer does not exist.
 */
export async function addTask(db: Db, customerId: string, input: TaskInput, user: string): Promise<Task | null> {
  if (!ID.test(customerId)) return null;
  const deal = input.deal_id && ID.test(input.deal_id) ? input.deal_id : null;
  const [made] = await db.sql<{ id: string }>`
    insert into follow_ups (customer_id, deal_id, kind, title, due_on, due_time, owner, created_by, updated_by)
    select c.id, (select d.id from deals d where d.id = ${deal}::bigint and d.customer_id = c.id),
           ${input.kind}, ${input.title}, ${input.due_on}::date, ${input.due_time}::time, ${input.owner}::citext, ${user}, ${user}
    from customers c where c.id = ${customerId}::bigint
    returning id::text as id`;
  return made ? getTask(db, made.id) : null;
}

/**
 * Tick one off: once, by whoever did it. It goes on the customer's timeline
 * as a note of its kind (a task as a plain note) with what came of it, and a
 * call, email, meeting or text moves their last contact. Null when it does
 * not exist; `already` when it was done before.
 */
export async function doneTask(db: Db, id: string, outcome: string | null, user: string): Promise<{ task: Task; already: boolean } | null> {
  if (!ID.test(id)) return null;
  const said = (outcome ?? "").trim().slice(0, 10_000);
  const [done] = await db.transaction([
    // The task, locked and still open; its note; then the task done, naming the note (Undo takes it back).
    q`with d as (
        select id, customer_id, kind, title from follow_ups where id = ${id}::bigint and done_at is null for update),
      n as (
        insert into customer_notes (customer_id, kind, body, author, happened_at)
        select d.customer_id, case when d.kind = 'task' then 'note' else d.kind end,
               d.title || case when ${said}::text <> '' then E'\\n' || ${said}::text else '' end, ${user}, now()
        from d
        returning id, customer_id),
      t as (
        update follow_ups f set done_at = now(), done_by = ${user}, done_note_id = (select id from n), updated_at = now(), updated_by = ${user}
        from d where f.id = d.id
        returning f.id)
      select customer_id from n`,
    // notes.ts's rule: the latest call, email, meeting or text noted.
    q`update customers c set
        last_contact_at = greatest(c.last_contact_at, (select max(n.happened_at) from customer_notes n where n.customer_id = c.id and n.kind <> 'note')),
        updated_at = now(), updated_by = ${user}
      where c.id = (select customer_id from follow_ups where id = ${id}::bigint)
        and c.last_contact_at is distinct from greatest(c.last_contact_at, (select max(n.happened_at) from customer_notes n where n.customer_id = c.id and n.kind <> 'note'))`,
  ]);
  const task = await getTask(db, id);
  return task ? { task, already: done.length === 0 } : null;
}

/**
 * Undo a tick, as Todoist's and HubSpot's: open again, and the timeline note
 * it made gone (found by its id, or, for one ticked before ids were kept, as
 * the note written in the same instant). When that note was their last
 * contact, their last contact is worked out again from what is left
 * (lastContactFrom), as HubSpot's last activity date is.
 * False when it is open or missing.
 */
export async function undoTask(db: Db, id: string, user: string): Promise<boolean> {
  if (!ID.test(id)) return false;
  const [r] = await db.sql<{ customer_id: string; was_last: boolean }>`
    with t as (
      select id, customer_id, done_note_id, done_at, done_by, title from follow_ups where id = ${id}::bigint and done_at is not null for update),
    note as (
      select n.id, n.happened_at from customer_notes n, t
      where n.id = t.done_note_id
         or (t.done_note_id is null and n.customer_id = t.customer_id and n.happened_at = t.done_at
             and n.author is not distinct from t.done_by and (n.body = t.title or n.body like t.title || E'\n%'))
      order by n.id limit 1),
    gone as (delete from customer_notes n using note where n.id = note.id returning n.happened_at),
    u as (
      update follow_ups f set done_at = null, done_by = null, done_note_id = null, updated_at = now(), updated_by = ${user}
      from t where f.id = t.id
      returning f.customer_id)
    select u.customer_id::text as customer_id,
           exists (select 1 from customers c, gone where c.id = u.customer_id and c.last_contact_at = gone.happened_at) as was_last
    from u`;
  if (!r) return false;
  if (r.was_last) await lastContactFrom(db, r.customer_id, user);
  return true;
}

/**
 * Their last contact, worked out again from everything that counts as
 * contact: a call, email, meeting or text noted, a completed event, a quote
 * or an invoice sent to them. Used when the one that was it is taken back.
 */
async function lastContactFrom(db: Db, customerId: string, user: string): Promise<void> {
  const has = await presentTables(db);
  const sent = (table: string, on: boolean) => (on ? `(select max(x.sent_at) from ${table} x where ${byEmail("x")})` : "null::timestamptz");
  await spliced({ event_of: EVENT_OF, quotes: sent("quotes", has.quotes), invoices: sent("invoices", has.invoices) }).sql(db)`
    update customers c set
      last_contact_at = greatest(
        (select max(n.happened_at) from customer_notes n where n.customer_id = c.id and n.kind <> 'note'),
        (select max(b.starts_at) from bookings b where b.status = 'completed' and b.starts_at <= now() and {event_of}),
        {quotes}, {invoices}),
      updated_at = now(), updated_by = ${user}
    where c.id = ${customerId}::bigint`;
}

/** Move an open one to another day (and time, when given; null for any time). False when it is done or missing. */
export async function moveTask(db: Db, id: string, dueOn: string, dueTime: string | null | undefined, user: string): Promise<boolean> {
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
 * Every open task, soonest first, so the overdue lead, as Todoist's and
 * HubSpot's open task lists run. `owner` narrows to one person's, `dueBy` to
 * those due on or before a day (the command's "what is due": today and
 * overdue); `limit` and one more.
 */
export async function listTasks(db: Db, owner: string | null, limit = 100, dueBy: string | null = null): Promise<Task[]> {
  return sql(db)<Task>`
    select {select} {from}
    where t.done_at is null and c.archived_at is null
      and (${owner}::text is null or t.owner = any(${owner ? sameAs(owner) : null}::citext[]))
      and (${dueBy}::date is null or t.due_on <= ${dueBy}::date)
    order by t.due_on, t.due_time nulls last, t.id
    limit ${limit + 1}`;
}

/** The ones done, newest first, whoever did them: the Tasks page's Done; `limit` and one more. */
export async function doneTasks(db: Db, limit = 100): Promise<Task[]> {
  return sql(db)<Task>`
    select {select} {from}
    where t.done_at is not null and c.archived_at is null
    order by t.done_at desc, t.id desc
    limit ${limit + 1}`;
}

/** How many are overdue and due today: everyone's, or one person's. */
export async function taskCounts(db: Db, today: string, owner: string | null): Promise<{ overdue: number; today: number }> {
  const [r] = await db.sql<{ overdue: number; today: number }>`
    select count(*) filter (where t.due_on < ${today}::date)::int as overdue,
           count(*) filter (where t.due_on = ${today}::date)::int as today
    from follow_ups t join customers c on c.id = t.customer_id
    where t.done_at is null and c.archived_at is null and t.due_on <= ${today}::date
      and (${owner}::text is null or t.owner = any(${owner ? sameAs(owner) : null}::citext[]))`;
  return r;
}

/** A customer's open ones, soonest first, and the last few done. */
export async function customerTasks(db: Db, customerId: string, dealId: string | null = null): Promise<{ open: Task[]; done: Task[] }> {
  if (!ID.test(customerId)) return { open: [], done: [] };
  // On a deal's page only that deal's, as Pipedrive's deal shows its own activities.
  const [open, done] = await Promise.all([
    sql(db)<Task>`select {select} {from} where t.customer_id = ${customerId}::bigint and (${dealId}::bigint is null or t.deal_id = ${dealId}::bigint)
      and t.done_at is null order by t.due_on, t.due_time nulls last, t.id`,
    sql(db)<Task>`select {select} {from} where t.customer_id = ${customerId}::bigint and (${dealId}::bigint is null or t.deal_id = ${dealId}::bigint)
      and t.done_at is not null order by t.done_at desc, t.id desc limit 5`,
  ]);
  return { open, done };
}

/** Each customer's next open one (a list row's mark), or each deal's (a pipeline card's), keyed by its id. */
export async function nextTasks(db: Db, ids: string[], by: "customer" | "deal" = "customer"): Promise<Map<string, { due_on: string; due_time: string | null }>> {
  const keys = ids.filter((x) => ID.test(x));
  if (!keys.length) return new Map();
  const rows = by === "deal"
    ? await db.sql<{ key: string; due_on: string; due_time: string | null }>`
        select distinct on (deal_id) deal_id::text as key, to_char(due_on, 'YYYY-MM-DD') as due_on, to_char(due_time, 'HH24:MI') as due_time
        from follow_ups where done_at is null and deal_id = any(${keys}::bigint[])
        order by deal_id, due_on, due_time nulls last, id`
    : await db.sql<{ key: string; due_on: string; due_time: string | null }>`
        select distinct on (customer_id) customer_id::text as key, to_char(due_on, 'YYYY-MM-DD') as due_on, to_char(due_time, 'HH24:MI') as due_time
        from follow_ups where done_at is null and customer_id = any(${keys}::bigint[])
        order by customer_id, due_on, due_time nulls last, id`;
  return new Map(rows.map((r) => [r.key, { due_on: r.due_on, due_time: r.due_time }]));
}

/**
 * Of these customers, the ones still in play: an open status, or an open
 * deal. Only they are marked when nothing is scheduled.
 */
export async function inPlay(db: Db, customerIds: string[]): Promise<Set<string>> {
  const ids = customerIds.filter((x) => ID.test(x));
  if (!ids.length) return new Set();
  const rows = await db.sql<{ id: string }>`
    select c.id::text as id from customers c
    where c.id = any(${ids}::bigint[])
      and (exists (select 1 from pipeline_stages s where s.key = c.stage and s.kind = 'open')
           or exists (select 1 from deals d join deal_stages s on s.key = d.stage where d.customer_id = c.id and d.archived_at is null and s.kind = 'open'))`;
  return new Set(rows.map((r) => r.id));
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
 * open task, no event scheduled from today on. Quietest first (their last
 * contact, or when they were added). `owner` narrows to the customers one
 * person looks after, or whose open deal they own. Days are calendar days in
 * `timeZone`: someone added late yesterday was added yesterday.
 */
export async function nothingPlanned(db: Db, owner: string | null, limit = 100, timeZone = "UTC"): Promise<Unplanned[]> {
  return sql(db)<Unplanned>`
    select c.id::text as id, c.name, c.phone, c.email::text as email, c.owner::text as owner,
           ((now() at time zone ${timeZone})::date - (coalesce(c.last_contact_at, c.created_at) at time zone ${timeZone})::date)::int as quiet_days,
           c.last_contact_at is not null as contacted,
           coalesce((select array_agg(d.title order by d.created_at) from deals d join deal_stages s on s.key = d.stage
                     where d.customer_id = c.id and d.archived_at is null and s.kind = 'open'), '{}') as deals
    from customers c
    where c.archived_at is null
      and {nothing_planned}
      and (${owner}::text is null or c.owner = any(${owner ? sameAs(owner) : null}::citext[])
           or exists (select 1 from deals d join deal_stages s on s.key = d.stage
                      where d.customer_id = c.id and d.archived_at is null and s.kind = 'open' and d.owner = any(${owner ? sameAs(owner) : null}::citext[])))
    order by coalesce(c.last_contact_at, c.created_at), c.id
    limit ${limit + 1}`;
}

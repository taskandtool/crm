// Deals: one piece of work the team is trying to win, for one customer, in
// the deal pipeline (deal_stages; stages.ts). A customer has as many as they
// bring over the years. Moving one to a won or lost stage closes it
// (closed_at); back to an open stage opens it again. Winning one makes its
// customer a customer: an open status moves to the first won status.
//
// A deal's value is what was typed in, or else the latest quote made for it
// (quotes.deal_id, the invoices skill's), so a quote's total shows on the
// card without anyone copying it over. A quote accepted after the deal last
// moved wins it (winFromQuotes), whichever way the yes came: the page, a
// script, or the customer paying online.
import type { Keyed } from "../admin/keyset";
import { q, type Db, type Query } from "../data/db";
import type { StageKind } from "../config-schema";

export type Deal = Keyed & {
  id: string;
  customer_id: string;
  title: string;
  stage: string;
  stage_changed_at: Date;
  value_cents: string | null;
  currency: string | null;
  owner: string | null;
  /** YYYY-MM-DD. */
  expected_close: string | null;
  closed_at: Date | null;
  lost_reason: string | null;
  notes: string | null;
  archived_at: Date | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  /** The value typed in, else the latest quote made for it that was not declined; null with neither. */
  shown_cents: string | null;
  /** True when shown_cents is a quote's total rather than a typed value. */
  from_quote: boolean;
};

export type DealInput = {
  title: string;
  value_cents: number | null;
  currency: string;
  owner: string | null;
  /** YYYY-MM-DD or null. */
  expected_close: string | null;
  notes: string | null;
};

// The quotes table is the invoices skill's and may not exist (quotes off), so
// the value's fallback is one of two fixed texts, chosen by whether it does;
// never input. Every read selects `{deal}` as the deal's columns: `d.*`,
// then expected_close again as text (pg reads a date as local midnight),
// which wins because node-postgres keeps the last column of a name.
const QUOTE_VALUE = `(select qt.total_cents from quotes qt where qt.deal_id = d.id and qt.status <> 'declined' order by qt.created_at desc, qt.id desc limit 1)`;
const COLUMNS = (quotes: boolean) => `d.*, d.updated_at::text as k, to_char(d.expected_close, 'YYYY-MM-DD') as expected_close,
  c.name as customer_name, c.email::text as customer_email, c.phone as customer_phone,
  coalesce(d.value_cents, ${quotes ? QUOTE_VALUE : "null::bigint"})::text as shown_cents,
  (d.value_cents is null and ${quotes ? QUOTE_VALUE : "null::bigint"} is not null) as from_quote`;

async function hasQuotes(db: Db): Promise<boolean> {
  const [r] = await db.sql<{ x: boolean }>`select to_regclass('quotes') is not null as x`;
  return r.x;
}

/** A statement whose text names `{deal}`, filled with the deal's columns for this database. */
async function dealSql(db: Db) {
  const quotes = await hasQuotes(db);
  const cols = COLUMNS(quotes);
  const fill = (strings: TemplateStringsArray) => {
    const out = strings.map((s) => s.replaceAll("{deal}", cols));
    return Object.assign(out, { raw: out }) as TemplateStringsArray;
  };
  return {
    quotes,
    sql: <T extends Record<string, any>>(strings: TemplateStringsArray, ...values: unknown[]) => db.sql<T>(fill(strings), ...values),
  };
}

const ID = /^\d{1,18}$/;

export async function getDeal(db: Db, id: string): Promise<Deal | null> {
  if (!ID.test(id)) return null;
  const { sql } = await dealSql(db);
  const [d] = await sql<Deal>`select {deal} from deals d join customers c on c.id = d.customer_id where d.id = ${id}::bigint`;
  return d ?? null;
}

/** A customer's deals: open ones first (newest first), then closed ones, most recently closed first. */
export async function customerDeals(db: Db, customerId: string, limit = 100): Promise<Deal[]> {
  if (!ID.test(customerId)) return [];
  const { sql } = await dealSql(db);
  return sql<Deal>`
    select {deal} from deals d join customers c on c.id = d.customer_id
    where d.customer_id = ${customerId}::bigint and d.archived_at is null
    order by d.closed_at is not null, d.closed_at desc nulls first, d.created_at desc, d.id desc
    limit ${limit}`;
}

/**
 * The board: every active deal in an open stage, and those closed in the
 * last `closedDays` in won and lost stages, up to `per` a stage (most
 * recently moved first); with each stage's count and total of what is
 * shown, in `currency` only (a value in another currency is counted, not
 * added).
 */
export async function board(db: Db, opts: { per: number; closedDays: number; currency: string }): Promise<{
  cards: Deal[];
  totals: Record<string, { count: number; cents: string; other: number }>;
}> {
  const { sql } = await dealSql(db);
  const rows = await sql<Deal & { n: number }>`
    select * from (
      select {deal}, row_number() over (partition by d.stage order by d.stage_changed_at desc, d.id desc)::int as n
      from deals d join customers c on c.id = d.customer_id
      where d.archived_at is null
        and (d.closed_at is null or d.closed_at >= now() - make_interval(days => ${opts.closedDays}::int))) r
    order by r.stage_changed_at desc, r.id desc`;
  const totals: Record<string, { count: number; cents: string; other: number }> = {};
  for (const d of rows) {
    const t = (totals[d.stage] ??= { count: 0, cents: "0", other: 0 });
    t.count++;
    if (d.shown_cents === null) continue;
    if ((d.currency ?? opts.currency).toUpperCase() === opts.currency.toUpperCase()) t.cents = (BigInt(t.cents) + BigInt(d.shown_cents)).toString();
    else t.other++;
  }
  return { cards: rows.filter((d) => d.n <= opts.per), totals };
}

/** Add a deal for a customer, in `stage`. Null when the customer or the stage does not exist. */
export async function createDeal(db: Db, customerId: string, input: DealInput, stage: string, user: string): Promise<Deal | null> {
  if (!ID.test(customerId)) return null;
  const [made] = await db.sql<{ id: string }>`
    with ins as (
      insert into deals (customer_id, title, stage, value_cents, currency, owner, expected_close, notes, closed_at, created_by, updated_by)
      select ${customerId}::bigint, ${input.title}, s.key, ${input.value_cents}::bigint, ${input.currency}, ${input.owner}::citext,
             ${input.expected_close}::date, ${input.notes}, case when s.kind = 'open' then null else now() end, ${user}, ${user}
      from deal_stages s
      where s.key = ${stage} and not s.archived and exists (select 1 from customers where id = ${customerId}::bigint)
      returning id, customer_id, stage),
    won as (
      update customers c set stage = w.key, updated_at = now(), updated_by = ${user}
      from (select key from pipeline_stages where not archived and kind = 'won' order by position, key limit 1) w, ins
      where c.id = ins.customer_id
        and exists (select 1 from deal_stages where key = ins.stage and kind = 'won')
        and exists (select 1 from pipeline_stages s where s.key = c.stage and s.kind = 'open'))
    select id::text as id from ins`;
  return made ? getDeal(db, made.id) : null;
}

/** Save what the deal page edits. The stage moves on its own (setDealStage). */
export async function saveDeal(db: Db, id: string, input: DealInput, user: string): Promise<Deal | null> {
  if (!ID.test(id)) return null;
  const rows = await db.sql`
    update deals set title = ${input.title}, value_cents = ${input.value_cents}::bigint, currency = ${input.currency},
      owner = ${input.owner}::citext, expected_close = ${input.expected_close}::date, notes = ${input.notes},
      updated_at = now(), updated_by = ${user}
    where id = ${id}::bigint
    returning id`;
  return rows.length ? getDeal(db, id) : null;
}

/**
 * Move a deal to an active stage. A won or lost stage closes it (a lost one
 * keeps `lostReason`); an open stage opens it again. Winning moves its
 * customer from an open status to the first won one. Null when either is
 * missing; the deal unchanged when it is already there.
 */
export async function setDealStage(db: Db, id: string, stage: string, user: string, lostReason: string | null = null): Promise<Deal | null> {
  if (!ID.test(id)) return null;
  const [moved] = await db.transaction([
    q`update deals d set stage = s.key, stage_changed_at = now(),
        closed_at = case when s.kind = 'open' then null else now() end,
        lost_reason = case when s.kind = 'lost' then coalesce(${lostReason}::text, d.lost_reason) end,
        updated_at = now(), updated_by = ${user}
      from deal_stages s
      where d.id = ${id}::bigint and s.key = ${stage} and not s.archived and d.stage <> s.key
      returning d.id`,
    customerWins(id, user),
  ]);
  if (!moved.length && !(await db.sql`select 1 from deals where id = ${id}::bigint and stage = ${stage}`).length) return null;
  return getDeal(db, id);
}

// The customer of a deal now in a won stage moves from an open status to the
// first won one. A customer in a won or lost status already, or a CRM with no
// won status, is left as it is.
const customerWins = (dealId: string, user: string): Query => q`
  update customers c set stage = w.key, updated_at = now(), updated_by = ${user}
  from (select key from pipeline_stages where not archived and kind = 'won' order by position, key limit 1) w
  where c.id = (select d.customer_id from deals d join deal_stages s on s.key = d.stage where d.id = ${dealId}::bigint and s.kind = 'won')
    and exists (select 1 from pipeline_stages s where s.key = c.stage and s.kind = 'open')`;

/**
 * Every open deal with a quote accepted since the deal last moved goes to the
 * first won stage, and its customer with it. Safe to run any time and any
 * number of times; a deal moved by hand after the yes stays where it was put.
 * Returns the deals it won, by title.
 */
export async function winFromQuotes(db: Db, user: string): Promise<{ id: string; title: string }[]> {
  if (!(await hasQuotes(db))) return [];
  const won = await db.sql<{ id: string; title: string }>`
    with w as (select key from deal_stages where not archived and kind = 'won' order by position, key limit 1),
    due as (
      select d.id from deals d join deal_stages s on s.key = d.stage
      where s.kind = 'open' and d.archived_at is null
        and exists (select 1 from quotes qt where qt.deal_id = d.id and qt.status = 'accepted' and qt.decided_at > d.stage_changed_at)
      for update of d)
    update deals d set stage = w.key, stage_changed_at = now(), closed_at = now(), lost_reason = null, updated_at = now(), updated_by = ${user}
    from w, due where d.id = due.id
    returning d.id::text as id, d.title`;
  for (const d of won) await db.transaction([customerWins(d.id, user)]);
  return won;
}

/**
 * The two pipeline figures on the first screen: deals open now, and deals won
 * since `since` (an instant: the start of the month in the business's zone),
 * each counted and totalled in `currency` (values in another currency are
 * counted, not added).
 */
export async function dealTotals(db: Db, currency: string, since: Date): Promise<{ open: { count: number; cents: string }; won: { count: number; cents: string } }> {
  const { sql } = await dealSql(db);
  const [r] = await sql<{ open_n: number; open_cents: string; won_n: number; won_cents: string }>`
    with x as (
      select {deal}, s.kind as stage_kind from deals d join customers c on c.id = d.customer_id join deal_stages s on s.key = d.stage
      where d.archived_at is null and (s.kind = 'open' or (s.kind = 'won' and d.closed_at >= ${since.toISOString()}::timestamptz)))
    select count(*) filter (where stage_kind = 'open')::int as open_n,
           coalesce(sum(shown_cents::bigint) filter (where stage_kind = 'open' and upper(coalesce(currency, ${currency})) = upper(${currency})), 0)::text as open_cents,
           count(*) filter (where stage_kind = 'won')::int as won_n,
           coalesce(sum(shown_cents::bigint) filter (where stage_kind = 'won' and upper(coalesce(currency, ${currency})) = upper(${currency})), 0)::text as won_cents
    from x`;
  return { open: { count: r.open_n, cents: r.open_cents }, won: { count: r.won_n, cents: r.won_cents } };
}

/** Why a lost deal was lost, said after it moved. False unless it is in a lost stage. */
export async function setLostReason(db: Db, id: string, reason: string | null, user: string): Promise<boolean> {
  if (!ID.test(id)) return false;
  const rows = await db.sql`
    update deals d set lost_reason = ${reason}, updated_at = now(), updated_by = ${user}
    from deal_stages s where d.id = ${id}::bigint and s.key = d.stage and s.kind = 'lost'
    returning d.id`;
  return rows.length > 0;
}

/** Archive or bring back a deal. Never deleted. */
export async function setDealArchived(db: Db, id: string, archived: boolean, user: string): Promise<boolean> {
  if (!ID.test(id)) return false;
  const rows = await db.sql`
    update deals set archived_at = case when ${archived}::boolean then coalesce(archived_at, now()) end, updated_at = now(), updated_by = ${user}
    where id = ${id}::bigint returning id`;
  return rows.length > 0;
}

/** Deals for the script's list: by one stage or a kind of stage, an owner, a customer; most recently changed first, `limit` and one more. */
export async function listDeals(db: Db, f: { stage: string | null; kind: StageKind | null; owner: string | null; customerId: string | null }, limit: number): Promise<Deal[]> {
  const { sql } = await dealSql(db);
  return sql<Deal>`
    select {deal} from deals d join customers c on c.id = d.customer_id join deal_stages s on s.key = d.stage
    where d.archived_at is null
      and (${f.stage}::text is null or d.stage = ${f.stage})
      and (${f.kind}::text is null or s.kind = ${f.kind})
      and (${f.owner}::text is null or d.owner = ${f.owner}::citext)
      and (${f.customerId}::bigint is null or d.customer_id = ${f.customerId}::bigint)
    order by d.updated_at desc, d.id desc
    limit ${limit + 1}`;
}

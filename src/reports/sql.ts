// Time series and totals for reports, aggregated in SQL in the business's
// zone. Three things go quietly wrong without this file:
//
// - Bucketing in UTC (or the server's zone) moves an evening lead into the
//   next day and splits a week at the wrong midnight. Every bucket here is a
//   calendar day, week (Monday) or month in `zone`, so a day bucket on the
//   fall-back day holds its 25 hours and a week stays seven local days.
// - A quiet week has no rows, so a plain `group by` leaves it out and the
//   chart draws a straight line over it. `generate_series` puts it back as 0.
// - A comparison with a period of a different length (this month against
//   last month, 30 days against 31) moves the number on its own. The previous
//   period is the same number of days, or of whole months for a month grain,
//   ending the day before.
//
// Periods are local calendar dates, both ends included: { from: "2026-09-01",
// to: "2026-09-30" }. They become instants only inside SQL, at midnight in
// the zone (`$1::date::timestamp at time zone $zone`).
//
// Table and column names cannot be parameters, and must never come from a
// request. They come only from SOURCES below, string literals in this file;
// a caller names a source by its key, which TypeScript checks. To chart
// another table, add an entry here: that is the whole extension point. The
// values (dates, zone, grain) are always parameters.
//
//   const p = lastFull("week", 12, zone);
//   const rows = await run(db, seriesQuery("leads", p, "week", zone));   // [{ bucket: "2026-07-13", value: 4 }, …]
//
// A composed query runs through `run`: Db.sql takes only a template, so a
// statement built from fixed fragments runs as a one-statement transaction,
// which both adapters accept.
import type { Db, Query, Row } from "../data/db";

export type Grain = "day" | "week" | "month";
export type Period = { from: string; to: string };

/** Run a composed statement (one of the builders below) and return its rows. */
export async function run<T extends Row = Row>(db: Db, query: Query): Promise<T[]> {
  const [rows] = await db.transaction([query]);
  return rows as T[];
}

// ---- What can be charted ----------------------------------------------------

type Source = {
  /** the table, by its plain name */
  table: string;
  /** the timestamptz column that places a row in a bucket */
  at: string;
  /** which rows count; plain SQL over the table's own columns */
  where: string;
  /** one aggregate call; a FILTER clause is appended to it */
  agg: string;
  /** money: the column naming each row's currency. Such a source is charted one currency at a time. */
  currency?: string;
};

export const SOURCES = {
  /** form submissions that are not spam, by when they arrived */
  leads: { table: "submissions", at: "created_at", where: "status is distinct from 'spam'", agg: "count(*)" },
  /** appointments held or due, by when they happen */
  bookings: { table: "bookings", at: "starts_at", where: "status <> 'cancelled'", agg: "count(*)" },
  /** bookings made, by when they were made, cancelled ones included */
  bookings_made: { table: "bookings", at: "created_at", where: "true", agg: "count(*)" },
  /** invoices paid, live money only, by when they were paid: minor units of one currency (the invoices skill) */
  invoices_paid: { table: "invoices", at: "paid_at", where: "status = 'paid' and livemode is true", agg: "sum(total_cents)", currency: "currency" },
} as const satisfies Record<string, Source>;

export type SourceName = keyof typeof SOURCES;

// ---- Periods -----------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GRAINS: readonly Grain[] = ["day", "week", "month"];
const DAY = 86_400_000;

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

function ms(date: string): number {
  const t = DATE.test(date) ? Date.parse(date + "T00:00:00Z") : NaN;
  // Date.parse rolls 2026-02-30 over to 2 March; Postgres refuses it. Refuse it here too.
  if (Number.isNaN(t) || iso(t) !== date) throw new Error(`not a date: ${date}`);
  return t;
}

export function addDays(date: string, n: number): string {
  return iso(ms(date) + n * DAY);
}

/** The first of the month `n` months from a first of the month. */
export function addMonths(firstOfMonth: string, n: number): string {
  if (!isMonthStart(firstOfMonth)) throw new Error(`not the first of a month: ${firstOfMonth}`);
  const d = new Date(ms(firstOfMonth));
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

const isMonthStart = (d: string) => DATE.test(d) && d.endsWith("-01");
const isMonthEnd = (d: string) => isMonthStart(addDays(d, 1));

/** Days in a period, both ends included. */
export function days(p: Period): number {
  return Math.round((ms(p.to) - ms(p.from)) / DAY) + 1;
}


/**
 * The period to compare with: the same number of days, ending the day before
 * `p` starts. With a month grain, whole months compare with the same number of
 * whole months, so month buckets line up. Only then: 28 days that happen to
 * be February compare with the 28 days before, not with January's 31.
 */
export function previousPeriod(p: Period, grain: Grain = "day"): Period {
  if (grain === "month" && isMonthStart(p.from) && isMonthEnd(p.to)) {
    const months = monthsBetween(p.from, addDays(p.to, 1));
    return { from: addMonths(p.from, -months), to: addDays(p.from, -1) };
  }
  const n = days(p);
  return { from: addDays(p.from, -n), to: addDays(p.from, -1) };
}

function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

/** Today's date in the zone, as YYYY-MM-DD. */
export function todayIn(zone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * The last `count` whole days, weeks (Monday to Sunday) or months before
 * today in the zone. `lag` pretends today is that many days earlier, for a
 * source whose recent days are not final yet (Search Console: 3).
 */
export function lastFull(grain: Grain, count: number, zone: string, opts: { now?: Date; lag?: number } = {}): Period {
  const today = addDays(todayIn(zone, opts.now), -(opts.lag ?? 0));
  if (grain === "day") return { from: addDays(today, -count), to: addDays(today, -1) };
  if (grain === "week") {
    const weekday = (new Date(ms(today)).getUTCDay() + 6) % 7; // Monday 0
    const to = addDays(today, -weekday - 1);
    return { from: addDays(to, -7 * count + 1), to };
  }
  const firstOfMonth = today.slice(0, 8) + "01";
  return { from: addMonths(firstOfMonth, -count), to: addDays(firstOfMonth, -1) };
}

function adjacent(prev: Period, p: Period) {
  check(prev, null, "UTC");
  if (addDays(prev.to, 1) !== p.from) throw new Error("the previous period must end the day before this one starts");
}

function check(p: Period, grain: Grain | null, zone: string) {
  if (ms(p.from) > ms(p.to)) throw new Error(`period ends before it starts: ${p.from} to ${p.to}`);
  if (grain !== null && !GRAINS.includes(grain)) throw new Error(`not a grain: ${grain}`);
  new Intl.DateTimeFormat("en", { timeZone: zone }); // throws RangeError on a zone that does not exist
}

// ---- Builders ---------------------------------------------------------------

/** A money source's currency filter, as parameter $n. Amounts in two currencies are never added. */
function inCurrency(s: Source, currency: string | undefined, n: number): { where: string; values: string[] } {
  if (!s.currency) {
    if (currency !== undefined) throw new Error("this source is not money: it takes no currency");
    return { where: "", values: [] };
  }
  if (!currency || !/^[a-z]{3}$/i.test(currency)) throw new Error("a money source is charted one currency at a time: pass its code, like usd");
  return { where: ` and lower(${s.currency}) = lower($${n})`, values: [currency] };
}

// The bounds of a period as instants, from parameters $1 (from), $2 (to) and
// the zone's parameter number.
const start = (z: string) => `($1::date::timestamp at time zone ${z})`;
const end = (z: string) => `(($2::date + 1)::timestamp at time zone ${z})`;

/**
 * One row per bucket of the period, zero where nothing happened:
 * `{ bucket: "YYYY-MM-DD", value: number }`, bucket being the local date the
 * day, week or month starts on. Align the period to the grain (lastFull does)
 * or the first and last buckets are partial.
 */
export function seriesQuery(name: SourceName, p: Period, grain: Grain, zone: string, currency?: string): Query {
  check(p, grain, zone);
  const s: Source = SOURCES[name];
  const money = inCurrency(s, currency, 5);
  return {
    text: `with buckets as (
  select generate_series(date_trunc($3, $1::date::timestamp), $2::date::timestamp, ('1 ' || $3)::interval) as bucket
), counted as (
  select date_trunc($3, ${s.at} at time zone $4) as bucket, ${s.agg} as value
  from ${s.table}
  where (${s.where})${money.where} and ${s.at} >= ${start("$4")} and ${s.at} < ${end("$4")}
  group by 1
)
select to_char(b.bucket, 'YYYY-MM-DD') as bucket, coalesce(c.value, 0)::float8 as value
from buckets b left join counted c using (bucket)
order by b.bucket`,
    values: [p.from, p.to, grain, zone, ...money.values],
  };
}

/**
 * The total for a period and for the period before it, in one pass:
 * `{ current: number, previous: number }`.
 */
export function compareQuery(name: SourceName, p: Period, zone: string, prev: Period = previousPeriod(p), currency?: string): Query {
  check(p, null, zone);
  adjacent(prev, p);
  const s: Source = SOURCES[name];
  const money = inCurrency(s, currency, 5);
  // $1..$2 is this period; $4 is where the previous one starts.
  const prevStart = `($4::date::timestamp at time zone $3)`;
  return {
    text: `select
  coalesce(${s.agg} filter (where ${s.at} >= ${start("$3")}), 0)::float8 as current,
  coalesce(${s.agg} filter (where ${s.at} < ${start("$3")}), 0)::float8 as previous
from ${s.table}
where (${s.where})${money.where} and ${s.at} >= ${prevStart} and ${s.at} < ${end("$3")}`,
    values: [p.from, p.to, zone, prev.from, ...money.values],
  };
}

// ---- Totals and ratios ------------------------------------------------------

/** Sum one numeric field over rows (pg returns bigint and numeric as text). */
export function sum<T>(rows: readonly T[], field: keyof T): number {
  let n = 0;
  for (const r of rows) n += Number(r[field] ?? 0);
  return n;
}

/**
 * A ratio over a set of rows, recomputed from the sums: CTR is total clicks
 * over total impressions, a conversion rate is total conversions over total
 * sessions. Averaging each row's ratio weights a page with 3 impressions the
 * same as one with 30,000. Null when the denominator is zero.
 */
export function ratioOfSums<T>(rows: readonly T[], numerator: keyof T, denominator: keyof T): number | null {
  const d = sum(rows, denominator);
  return d === 0 ? null : sum(rows, numerator) / d;
}

/**
 * A mean weighted by another field, for an average that was itself an
 * average per row (Search Console's position, weighted by impressions).
 */
export function weightedMean<T>(rows: readonly T[], field: keyof T, weight: keyof T): number | null {
  let w = 0;
  let total = 0;
  for (const r of rows) {
    const v = r[field];
    const k = Number(r[weight] ?? 0);
    if (v === null || v === undefined || k === 0) continue;
    total += Number(v) * k;
    w += k;
  }
  return w === 0 ? null : total / w;
}

// ---- The operations report --------------------------------------------------
//
// These read the forms, booking and payments tables by fixed names and run only when the tables
// exist (`projectTables`). Every period bound is computed in SQL in the zone.

/** `paymentTotals`: payments has total_cents (payments 0.2.0 and later), what was paid with tax and fees. */
export type ProjectTables = { submissions: boolean; forms: boolean; bookings: boolean; payments: boolean; paymentTotals?: boolean };

/** Which of those tables this project has. A project without booking has no bookings. */
export async function projectTables(db: Db): Promise<ProjectTables> {
  const rows = await db.sql<{ table_name: string }>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name in ('submissions', 'forms', 'bookings', 'payments')`;
  const has = new Set(rows.map((r) => r.table_name));
  const [totals] = await db.sql<{ yes: boolean }>`
    select exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'payments' and column_name = 'total_cents') as yes`;
  return { submissions: has.has("submissions"), forms: has.has("forms"), bookings: has.has("bookings"), payments: has.has("payments"), paymentTotals: totals.yes };
}

/**
 * Revenue per currency for a period and the one before, in minor units:
 * `{ currency, gross, refunds, net, previous_net }`. Amounts in different
 * currencies are never added together; each currency is its own row and its
 * own figure.
 *
 * Gross is every payment taken in the period (placed by `paid_at`, or
 * `created_at` while a refund that arrived first leaves it empty), refunds
 * are what has been given back of those (`refunded_cents`, whole or part),
 * and net is what the business kept. Test-mode payments (`livemode` false)
 * are not revenue.
 */
export function revenueQuery(p: Period, zone: string, prev: Period = previousPeriod(p), opts: { totals?: boolean } = {}): Query {
  check(p, null, zone);
  adjacent(prev, p);
  // What was paid: the total with tax and fees where the payments table records it (refunds come back with tax).
  const paid = opts.totals ? "coalesce(total_cents, amount_cents)" : "amount_cents";
  // A refund event that reaches the webhook before the payment event leaves
  // paid_at empty until that one arrives (if it ever does); meanwhile such a
  // payment is placed by when it was created rather than left out.
  const at = "coalesce(paid_at, created_at)";
  const cur = `${at} >= ${start("$3")}`;
  return {
    text: `select upper(currency) as currency,
  coalesce(sum(${paid}) filter (where ${cur}), 0)::float8 as gross,
  coalesce(sum(refunded_cents) filter (where ${cur}), 0)::float8 as refunds,
  coalesce(sum(${paid} - refunded_cents) filter (where ${cur}), 0)::float8 as net,
  coalesce(sum(${paid} - refunded_cents) filter (where not (${cur})), 0)::float8 as previous_net
from payments
where status in ('paid', 'partially_refunded', 'refunded') and livemode is not false
  and ${at} >= ($4::date::timestamp at time zone $3) and ${at} < ${end("$3")}
group by 1
order by gross desc, 1`,
    values: [p.from, p.to, zone, prev.from],
  };
}

/**
 * The funnel lead, booked, showed, paid for the people who became a lead in
 * the period, matched by email (case-blind, whatever the column type). Each
 * step counts people from the step before, so the funnel only narrows. Steps
 * for a missing table are left out: `{ step, people }` rows in order.
 */
export function funnelQuery(p: Period, zone: string, has: ProjectTables): Query | null {
  check(p, null, zone);
  if (!has.submissions) return null;
  const inPeriod = (col: string) => `${col} >= ${start("$3")} and ${col} < ${end("$3")}`;
  const ctes = [
    `lead as (select distinct lower(email::text) as e from submissions
      where email is not null and status is distinct from 'spam' and ${inPeriod("created_at")})`,
  ];
  const steps = ["lead"];
  if (has.bookings) {
    ctes.push(
      `booked as (select distinct l.e from lead l join bookings b on lower(b.email::text) = l.e
        where b.status <> 'cancelled' and ${inPeriod("b.created_at")})`,
      `showed as (select distinct k.e from booked k join bookings b on lower(b.email::text) = k.e
        where b.status = 'completed' and ${inPeriod("b.starts_at")})`,
    );
    steps.push("booked", "showed");
  }
  if (has.payments) {
    const from = steps[steps.length - 1];
    ctes.push(
      `paid as (select distinct f.e from ${from} f join payments pay on lower(pay.email::text) = f.e
        where pay.status in ('paid', 'partially_refunded') and pay.livemode is not false and ${inPeriod("coalesce(pay.paid_at, pay.created_at)")})`,
    );
    steps.push("paid");
  }
  return {
    text: `with ${ctes.join(",\n")}
select step, people from (
${steps.map((s, i) => `  select ${i} as n, '${s}' as step, count(*)::float8 as people from ${s}`).join("\n  union all\n")}
) steps order by n`,
    values: [p.from, p.to, zone],
  };
}

/**
 * Non-spam leads by where the visitor came from, most first: the UTM source
 * the forms skill stored, else the referring site's host, else "direct".
 * `submissions.source` is the app that took the form, which no owner means
 * by "where did my leads come from".
 */
export function leadsByOriginQuery(p: Period, zone: string, limit = 12): Query {
  check(p, null, zone);
  return {
    text: `select coalesce(nullif(data->'_utm'->>'source', ''), nullif(data->>'_referrer', ''), 'direct') as origin, count(*)::float8 as leads
from submissions
where status is distinct from 'spam' and created_at >= ${start("$3")} and created_at < ${end("$3")}
group by 1 order by 2 desc, 1 limit $4`,
    values: [p.from, p.to, zone, limit],
  };
}

/** Non-spam leads per form in the period, most first, named by the form's title when forms is there. */
export function leadsByFormQuery(p: Period, zone: string, has: ProjectTables, limit = 12): Query {
  check(p, null, zone);
  const name = has.forms ? "coalesce((select f.title from forms f where f.key = s.form_key), s.form_key)" : "s.form_key";
  return {
    text: `select ${name} as form, count(*)::float8 as leads
from submissions s
where s.status is distinct from 'spam' and s.created_at >= ${start("$3")} and s.created_at < ${end("$3")}
group by 1 order by 2 desc, 1 limit $4`,
    values: [p.from, p.to, zone, limit],
  };
}

/** The most recently made bookings; `starts_at` is an ISO instant for admin's <When timeZone>. */
export function recentBookingsQuery(limit = 10): Query {
  return {
    text: `select id::text as id, name, email::text as email, status,
  to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as starts_at
from bookings
order by created_at desc, id desc
limit $1`,
    values: [limit],
  };
}

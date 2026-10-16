// Recurring invoices: lines that become an ordinary invoice on each date,
// made by one daily run (Task & Tool's scheduled job runs the app's command),
// then left as a draft for a person, sent to be paid, or charged to the card
// on file. Every invoice it makes is a draft first and goes to Stripe through
// sendInvoice, as any other: one lifecycle.
//
//   const r = await createRecurring(db, { email, title: "Maintenance plan", unit: "month", every: "1", first_on: "2026-11-01",
//                                         mode: "charge", currency: "usd", lines: [...] }, by, "crm");
//   const done = await runRecurring(db, { today: todayIn(zone), timeZone: zone, stripe: () => stripeFrom(env), task });
//
// Dates are business dates in the app's zone; the run's hour never decides
// one. Period n is `first_on` plus n x `every` weeks, months or years,
// computed from `first_on` each time (never from the last), and a month or
// year's first date is the 1st to the 28th, so nothing clamps or drifts.
// A period is due on its date (a draft `days_ahead` before it). The run
// makes every due period not made yet, one invoice per period; a period
// more than LATE_DAYS past is made as a draft whatever the mode, with a task.
import { q, type Db } from "../data/db";
import type { Stripe } from "../payments/stripe";
import { formatMoney } from "../payments/money";
import { taxRates } from "../payments/tax";
import { addDays, isDay } from "./document";
import { invoiceById, type Invoice } from "./invoices";
import { clearLines, insertLines, keptRates, readLines, sumLines, toLine, type Errors, type Line, type Saved, type SavedLine } from "./lines";
import { readHead } from "./quotes";
import { sendInvoice } from "./stripe";

export const UNITS = ["week", "month", "year"] as const;
export type Unit = (typeof UNITS)[number];
export const MODES = ["draft", "send", "charge"] as const;
export type Mode = (typeof MODES)[number];
export const MODE_LABELS: Record<Mode, string> = {
  draft: "A draft for us to review",
  send: "Email it to be paid",
  charge: "Charge their card",
};
export type RecurringStatus = "pending" | "active" | "paused" | "ended";
export const RECURRING_STATUS_LABELS: Record<RecurringStatus, string> = {
  pending: "Waiting for a yes", active: "Active", paused: "Paused", ended: "Ended",
};

const SCHEDULE_FIXED = "How often and the first date are set once its first invoice is made. End this one and start another to change them.";

/** Days past its date after which a period is made as a draft, never sent or charged. */
export const LATE_DAYS = 2;

export type Recurring = {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  address: string | null;
  title: string;
  currency: string;
  subtotal_cents: string;
  tax_cents: string;
  total_cents: string;
  unit: Unit;
  every: number;
  first_on: string;
  next_n: number;
  next_on: string;
  ends_on: string | null;
  ends_after: number | null;
  made: number;
  mode: Mode;
  days_ahead: number;
  days_until_due: number;
  notes: string | null;
  note_for_team: string | null;
  owner: string | null;
  status: RecurringStatus;
  quote_id: string | null;
  checked_at: Date | null;
  source: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
};

// ---- dates ------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** Period n's date: `first` plus n x `every` units, from `first` itself. */
export function periodOn(first: string, unit: Unit, every: number, n: number): string {
  if (unit === "week") return addDays(first, 7 * every * n);
  const [y, m, d] = first.split("-").map(Number);
  const t = m - 1 + (unit === "year" ? 12 : 1) * every * n;
  return `${y + Math.floor(t / 12)}-${pad((t % 12) + 1)}-${pad(d)}`;
}

/** Whole days from `a` to `b` (YYYY-MM-DD each). */
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

const fmt = (day: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...o }).format(new Date(day + "T00:00:00Z"));
/** "Nov 1, 2026". */
export const shortDay = (day: string) => fmt(day, { month: "short", day: "numeric", year: "numeric" });
const ordinal = (n: number) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");

/** "every month on the 1st", "every 2 weeks on Monday", "every year on November 1". */
export function scheduleText(r: Pick<Recurring, "unit" | "every" | "first_on">): string {
  const each = r.every === 1 ? `every ${r.unit}` : `every ${r.every} ${r.unit}s`;
  if (r.unit === "week") return `${each} on ${fmt(r.first_on, { weekday: "long" })}`;
  if (r.unit === "month") return `${each} on the ${ordinal(Number(r.first_on.slice(8)))}`;
  return `${each} on ${fmt(r.first_on, { month: "long", day: "numeric" })}`;
}

/** The period an invoice bills, for its page: "November 2026", or "the week of Nov 2, 2026". */
export const periodLabel = (unit: Unit, day: string) =>
  unit === "week" ? `the week of ${shortDay(day)}` : fmt(day, { month: "long", year: "numeric" });

/** For a task: "Ann Lee's November 2026 invoice", "Ann Lee's invoice for the week of Nov 2, 2026". */
const invoiceOf = (who: string, unit: Unit, day: string) =>
  unit === "week" ? `${who}'s invoice for ${periodLabel(unit, day)}` : `${who}'s ${periodLabel(unit, day)} invoice`;

/** "until Oct 1, 2027", "for 12 invoices (the last on Oct 1, 2027)", or "". */
export function endsText(r: Pick<Recurring, "unit" | "every" | "first_on" | "ends_on" | "ends_after">): string {
  if (r.ends_after) return `for ${r.ends_after} ${r.ends_after === 1 ? "invoice" : "invoices"} (the last on ${shortDay(periodOn(r.first_on, r.unit, r.every, r.ends_after - 1))})`;
  if (r.ends_on) return `until ${shortDay(r.ends_on)}`;
  return "";
}

/** How each one is collected, in words, with the card when there is one. */
export function collectText(mode: Mode, card: string | null, who: "them" | "you" = "them"): string {
  if (mode === "draft") return "made as a draft for the team to review and send";
  if (mode === "send") return `emailed to ${who === "you" ? "you" : "them"} to pay`;
  const theirs = who === "you" ? "your" : "their";
  return card ? `charged to ${card}` : `charged to ${theirs} card (emailed to pay until one is on file)`;
}

/** The team's sentence: "An invoice for $300.00, every month on the 1st from Nov 1, 2026, charged to Visa 4242." */
export function describe(r: Recurring, card: string | null = null): string {
  const ends = endsText(r);
  return `An invoice for ${formatMoney(r.total_cents, r.currency)}, ${scheduleText(r)} from ${shortDay(r.first_on)}${ends ? ` ${ends}` : ""}, ${collectText(r.mode, card)}.`;
}

/** The customer's sentence, on a proposal: "From Nov 1, 2026: $1,000.00 every month on the 1st, charged to your card." */
export function describeForCustomer(r: Recurring): string {
  const ends = endsText(r);
  const how = r.mode === "draft" ? "invoiced to you" : collectText(r.mode, null, "you");
  return `From ${shortDay(r.first_on)}: ${formatMoney(r.total_cents, r.currency)} ${scheduleText(r)}${ends ? ` ${ends}` : ""}, ${how}.`;
}

// ---- the record -------------------------------------------------------------

export type RecurringFields = {
  email?: unknown; name?: unknown; phone?: unknown; address?: unknown; currency?: unknown;
  title?: unknown; unit?: unknown; every?: unknown; first_on?: unknown;
  /** never | on | after */
  ends?: unknown; ends_on?: unknown; ends_after?: unknown;
  mode?: unknown; days_ahead?: unknown; days_until_due?: unknown;
  notes?: unknown; note_for_team?: unknown; owner?: unknown;
  lines?: unknown;
};

type Read = {
  head: ReturnType<typeof readHead>; title: string; unit: Unit; every: number; first_on: string; ends_on: string | null; ends_after: number | null;
  mode: Mode; days_ahead: number; days_until_due: number; note_for_team: string | null; owner: string | null; lines: Line[];
};

const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const whole = (v: unknown, dflt: number, lo: number, hi: number): number | null => {
  const t = text(v);
  if (!t) return dflt;
  return /^\d{1,4}$/.test(t) && Number(t) >= lo && Number(t) <= hi ? Number(t) : null;
};

async function readRecurring(db: Db, f: RecurringFields, id?: string): Promise<Saved<Read>> {
  const errors: Errors = {};
  const head = readHead({ email: f.email, name: f.name, phone: f.phone, address: f.address, currency: f.currency, notes: f.notes, valid_until: null, terms: null }, errors);
  const title = text(f.title);
  if (!title || title.length > 200) errors.title = "Name it in up to 200 characters, like Maintenance plan.";
  const unit = UNITS.find((u) => u === text(f.unit));
  if (!unit) errors.unit = "Choose weeks, months or years.";
  const every = whole(f.every, 1, 1, 12);
  if (every === null) errors.every = "Every 1 to 12.";
  const first = text(f.first_on);
  if (!isDay(first)) errors.first_on = "Enter the first invoice's date, like 2026-11-01.";
  // Every month has the 1st to the 28th: a month's or year's day never clamps or drifts.
  else if (unit && unit !== "week" && Number(first.slice(8)) > 28) errors.first_on = "Choose the 1st to the 28th, so every month has the day.";
  const ends = text(f.ends) || "never";
  let ends_on: string | null = null, ends_after: number | null = null;
  if (ends === "on") {
    ends_on = text(f.ends_on);
    if (!isDay(ends_on)) errors.ends_on = "Enter the last date, like 2027-10-31.";
    else if (isDay(first) && ends_on < first) errors.ends_on = "The end is after the first invoice.";
  } else if (ends === "after") {
    ends_after = whole(f.ends_after, 0, 1, 1000);
    if (!ends_after) errors.ends_after = "A number of invoices, 1 to 1000.";
  } else if (ends !== "never") errors.ends = "Never, on a date, or after a number of invoices.";
  const mode = MODES.find((m) => m === text(f.mode));
  if (!mode) errors.mode = "Choose what happens on each date.";
  const days_ahead = whole(f.days_ahead, 3, 0, 14);
  if (days_ahead === null) errors.days_ahead = "0 to 14 days before.";
  const days_until_due = whole(f.days_until_due, 30, 0, 365);
  if (days_until_due === null) errors.days_until_due = "Enter the days to pay, 0 to 365.";
  const note = text(f.note_for_team);
  if (note.length > 1000) errors.note_for_team = "Up to 1000 characters.";
  const owner = text(f.owner);
  if (owner.length > 200) errors.owner = "Up to 200 characters.";
  const lines = readLines(f.lines, head.currency, await taxRates(db), id ? await keptRates(db, "recurring", id) : []);
  if (!lines.ok) Object.assign(errors, lines.errors);
  if (Object.keys(errors).length || !lines.ok) return { ok: false, errors };
  return {
    ok: true,
    value: {
      head, title, unit: unit!, every: every!, first_on: first, ends_on, ends_after, mode: mode!, days_ahead: days_ahead!,
      days_until_due: days_until_due!, note_for_team: note || null, owner: owner || null, lines: lines.value,
    },
  };
}

/**
 * What saving would make, checked and totalled, without saving: the
 * preview a person or the AI reads before --confirm. Totals as lines.ts
 * computes them (quantity x price rounded; tax per line, inside an
 * inclusive price).
 */
export async function previewRecurring(db: Db, f: RecurringFields, now?: Recurring): Promise<Saved<Recurring>> {
  const r = await readRecurring(db, f, now?.id);
  if (!r.ok) return r;
  const v = r.value, rates = await taxRates(db);
  if (now && now.made > 0 && (v.unit !== now.unit || v.every !== now.every || v.first_on !== now.first_on)) return { ok: false, errors: { first_on: SCHEDULE_FIXED } };
  let sub = 0, tax = 0, exclusive = 0;
  for (const l of v.lines) {
    const amount = Math.round(Number(l.quantity) * l.unit_cents);
    const rate = rates.find((x) => x.id === l.tax_rate_id);
    const t = !rate ? 0 : rate.inclusive ? amount - Math.round((amount * 10000) / (10000 + rate.percent_bp)) : Math.round((amount * rate.percent_bp) / 10000);
    sub += amount;
    tax += t;
    if (rate && !rate.inclusive) exclusive += t;
  }
  const at = new Date();
  return {
    ok: true,
    value: {
      id: now?.id ?? "", email: v.head.email, name: v.head.name, phone: v.head.phone, address: v.head.address, title: v.title, currency: v.head.currency,
      subtotal_cents: String(sub), tax_cents: String(tax), total_cents: String(sub + exclusive), unit: v.unit, every: v.every, first_on: v.first_on,
      next_n: now?.next_n ?? 0, next_on: now && now.made > 0 ? now.next_on : v.first_on, ends_on: v.ends_on, ends_after: v.ends_after, made: now?.made ?? 0,
      mode: v.mode, days_ahead: v.days_ahead, days_until_due: v.days_until_due, notes: v.head.notes, note_for_team: v.note_for_team, owner: v.owner,
      status: now?.status ?? "active", quote_id: now?.quote_id ?? null, checked_at: now?.checked_at ?? null, source: now?.source ?? null,
      created_by: now?.created_by ?? null, updated_by: now?.updated_by ?? null, created_at: now?.created_at ?? at, updated_at: at,
    },
  };
}

const SELECT = q`select *, to_char(first_on, 'YYYY-MM-DD') as first_day, to_char(next_on, 'YYYY-MM-DD') as next_day, to_char(ends_on, 'YYYY-MM-DD') as ends_day from recurring_invoices`;

/**
 * A new recurring invoice. `pending` (a proposal's "Then, recurring") waits
 * for its quote's yes; anything else starts active, its first invoice on
 * `first_on`.
 */
export async function createRecurring(db: Db, f: RecurringFields, by: string, source: string, opts: { pending?: { quoteId: string } } = {}): Promise<Saved<Recurring>> {
  const r = await readRecurring(db, f);
  if (!r.ok) return r;
  const v = r.value, h = v.head;
  const out = await db.transaction([
    q`insert into recurring_invoices (email, name, phone, address, title, currency, unit, every, first_on, next_on, ends_on, ends_after, mode,
        days_ahead, days_until_due, notes, note_for_team, owner, status, quote_id, source, created_by, updated_by)
      values (${h.email}, ${h.name}, ${h.phone}, ${h.address}, ${v.title}, ${h.currency}, ${v.unit}, ${v.every}, ${v.first_on}::date, ${v.first_on}::date,
        ${v.ends_on}::date, ${v.ends_after}::int, ${v.mode}, ${v.days_ahead}, ${v.days_until_due}, ${h.notes}, ${v.note_for_team}, ${v.owner},
        ${opts.pending ? "pending" : "active"}, ${opts.pending?.quoteId ?? null}::bigint, ${source}, ${by}, ${by})`,
    insertLines("recurring", null, v.lines),
    sumLines("recurring", null),
    { text: SELECT.text + ` where id = currval(pg_get_serial_sequence('recurring_invoices', 'id'))`, values: [] },
  ]);
  return { ok: true, value: toRecurring(out[3][0]) };
}

/**
 * Change one that has not ended; it applies from the next invoice (drafts
 * already made stay as they are). Its schedule (how often and the first
 * date) is fixed once an invoice is made: periods count from the first date.
 */
export async function saveRecurring(db: Db, id: string, f: RecurringFields, by: string): Promise<Saved<Recurring>> {
  const now = await recurringById(db, id);
  if (!now) return { ok: false, errors: { status: "No such recurring invoice." } };
  if (now.status === "ended") return { ok: false, errors: { status: "This recurring invoice has ended. Start a new one." } };
  const r = await readRecurring(db, f, id);
  if (!r.ok) return r;
  const v = r.value, h = v.head;
  if (now.made > 0 && (v.unit !== now.unit || v.every !== now.every || v.first_on !== now.first_on)) {
    return { ok: false, errors: { first_on: SCHEDULE_FIXED } };
  }
  const out = await db.transaction([
    q`update recurring_invoices set email = ${h.email}, name = ${h.name}, phone = ${h.phone}, address = ${h.address}, title = ${v.title},
        currency = ${h.currency}, unit = ${v.unit}, every = ${v.every}, first_on = ${v.first_on}::date,
        next_on = case when made = 0 then ${v.first_on}::date else next_on end, next_n = case when made = 0 then 0 else next_n end,
        ends_on = ${v.ends_on}::date, ends_after = ${v.ends_after}::int, mode = ${v.mode}, days_ahead = ${v.days_ahead},
        days_until_due = ${v.days_until_due}, notes = ${h.notes}, note_for_team = ${v.note_for_team}, owner = ${v.owner},
        updated_by = ${by}, updated_at = now()
      where id = ${id}::bigint and status <> 'ended'`,
    clearLines("recurring", id),
    insertLines("recurring", id, v.lines),
    sumLines("recurring", id),
    { text: SELECT.text + " where id = $1::bigint", values: [id] },
  ]);
  return { ok: true, value: toRecurring(out[4][0]) };
}

export async function recurringById(db: Db, id: string): Promise<(Recurring & { lines: SavedLine[] }) | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [rows, lines] = await db.transaction([
    { text: SELECT.text + " where id = $1::bigint", values: [id] },
    q`select * from recurring_invoice_lines where recurring_id = ${id}::bigint order by position, id`,
  ]);
  return rows[0] ? { ...toRecurring(rows[0]), lines: lines.map(toLine) } : null;
}

/** For one customer, or one quote's; or every one not ended (`all`: ended too), next date first. */
export async function recurringList(db: Db, by: { email?: string | null; quoteId?: string | null; all?: boolean } = {}): Promise<Recurring[]> {
  const rows = await db.transaction([{
    text: SELECT.text + ` where ($1::citext is null or email = $1::citext) and ($2::bigint is null or quote_id = $2::bigint)
      and ($3::boolean or status <> 'ended') order by status = 'ended', next_on, id limit 500`,
    values: [by.email ?? null, by.quoteId ?? null, !!by.all || !!by.quoteId || !!by.email],
  }]);
  return rows[0].map(toRecurring);
}

/** The invoices one made, newest period first. */
export async function invoicesOf(db: Db, id: string): Promise<Invoice[]> {
  const rows = await db.sql`select id::text as id from invoices where recurring_id = ${id}::bigint order by period_on desc, id desc limit 200`;
  return (await Promise.all(rows.map((r) => invoiceById(db, r.id)))).filter((x): x is NonNullable<typeof x> => !!x);
}

/** When the run last looked at the active ones (it stamps them all): the newest `checked_at`; null when it never has. */
export async function lastRun(db: Db): Promise<{ active: number; checked: Date | null }> {
  const [r] = await db.sql`
    select count(*)::int as active, max(checked_at) as checked from recurring_invoices where status = 'active'`;
  return { active: Number(r.active), checked: r.checked ? new Date(r.checked) : null };
}

// The next period still to come: the first from today on, counted from first_on.
async function skipPast(db: Db, id: string, today: string): Promise<void> {
  const r = await recurringById(db, id);
  if (!r) return;
  let n = r.next_n;
  while (periodOn(r.first_on, r.unit, r.every, n) < today) n++;
  if (n !== r.next_n) {
    await db.sql`update recurring_invoices set next_n = ${n}, next_on = ${periodOn(r.first_on, r.unit, r.every, n)}::date, updated_at = now()
      where id = ${id}::bigint and next_n = ${r.next_n}`;
  }
}

/** Pause: nothing is made until it is resumed. */
export async function pauseRecurring(db: Db, id: string, by: string): Promise<boolean> {
  const rows = await db.sql`update recurring_invoices set status = 'paused', updated_by = ${by}, updated_at = now() where id = ${id}::bigint and status = 'active' returning id`;
  return rows.length > 0;
}

/** Resume from the next date to come; the dates missed while paused are never made. */
export async function resumeRecurring(db: Db, id: string, by: string, today: string): Promise<boolean> {
  const rows = await db.sql`update recurring_invoices set status = 'active', updated_by = ${by}, updated_at = now() where id = ${id}::bigint and status = 'paused' returning id`;
  if (rows.length) await skipPast(db, id, today);
  return rows.length > 0;
}

/** End it: no more invoices. Those made stay. */
export async function endRecurring(db: Db, id: string, by: string): Promise<boolean> {
  const rows = await db.sql`update recurring_invoices set status = 'ended', updated_by = ${by}, updated_at = now() where id = ${id}::bigint and status <> 'ended' returning id`;
  return rows.length > 0;
}

// ---- the run ----------------------------------------------------------------

export type RunDeps = {
  /** Today in the business's zone. */
  today: string;
  timeZone: string;
  /** Opened only when something is sent or charged. */
  stripe: () => Stripe;
  /** A task for a person: the app's own (the CRM's follow-ups, for the customer with this email). Never throws for a missing customer. */
  task?: (r: Recurring, t: { title: string; due_on: string }) => Promise<void>;
  /** Who it acts as. */
  by?: string;
};

export type Outcome = "draft" | "sent" | "charged" | "emailed" | "failed";
export type Made = { recurring: Recurring; invoice: Invoice; outcome: Outcome; message?: string };

/**
 * Make one period's invoice, the next one due (or `force`: the next one now,
 * whatever its date), and move on to the following period, in one statement
 * behind a lock on the recurring invoice. A period already made (a second
 * run) is not made again. Null when nothing was due.
 */
async function makeNext(db: Db, id: string, today: string, force: boolean, by: string): Promise<{ invoiceId: string | null; period: string } | null> {
  const [[row]] = await db.transaction([q`
    with r as (
      select * from recurring_invoices
      where id = ${id}::bigint and status = 'active'
        and (ends_on is null or next_on <= ends_on) and (ends_after is null or made < ends_after)
        and (${force} or next_on - case when mode = 'draft' then days_ahead else 0 end <= ${today}::date)
      for update),
    made as (
      insert into invoices (recurring_id, period_on, email, name, phone, address, currency, subtotal_cents, tax_cents, total_cents,
                            days_until_due, notes, source, created_by, updated_by)
      select r.id, r.next_on, r.email, r.name, r.phone, r.address, r.currency, r.subtotal_cents, r.tax_cents, r.total_cents,
             r.days_until_due, r.notes, r.source, ${by}, ${by}
      from r
      on conflict (recurring_id, period_on) where recurring_id is not null do nothing
      returning id, recurring_id),
    copied as (
      insert into invoice_lines (invoice_id, position, description, quantity, unit_cents, tax_rate_id, amount_cents, tax_cents)
      select made.id, l.position, l.description, l.quantity, l.unit_cents, l.tax_rate_id, l.amount_cents, l.tax_cents
      from made join recurring_invoice_lines l on l.recurring_id = made.recurring_id
      returning id),
    moved as (
      update recurring_invoices x set
        next_n = r.next_n + 1,
        next_on = (r.first_on + case r.unit when 'week' then make_interval(weeks => (r.next_n + 1) * r.every)
                                            when 'month' then make_interval(months => (r.next_n + 1) * r.every)
                                            else make_interval(years => (r.next_n + 1) * r.every) end)::date,
        made = r.made + (select count(*) from made),
        updated_at = now()
      from r where x.id = r.id
      returning x.id)
    select (select id::text from made) as invoice_id, (select to_char(next_on, 'YYYY-MM-DD') from r) as period,
           (select count(*) from copied) as lines, (select count(*) from moved) as moved`]);
  if (!row?.period) return null;
  return { invoiceId: row.invoice_id ?? null, period: row.period };
}

// Past its end (a date, or a number of invoices): ended. makeNext never makes a period past it either way.
const endFinished = () => q`
  update recurring_invoices set status = 'ended', updated_at = now()
  where status = 'active'
    and ((ends_on is not null and next_on > ends_on) or (ends_after is not null and made >= ends_after))
  returning id`;

/** Act on a period's new invoice as its recurring invoice says; never throws for Stripe. */
async function act(db: Db, r: Recurring, invoice: Invoice, deps: RunDeps, late: boolean): Promise<Made> {
  const by = deps.by ?? "Recurring invoices";
  const name = invoiceOf(r.name ?? r.email, r.unit, invoice.period_on ?? r.next_on);
  const task = async (title: string, due_on = deps.today) => deps.task?.(r, { title: title.slice(0, 300), due_on });
  if (late) {
    await task(`${name} was made ${daysBetween(invoice.period_on!, deps.today)} days late, so it waits as a draft. Check it and send it.`);
    return { recurring: r, invoice, outcome: "draft" };
  }
  if (r.mode === "draft") {
    await task(`Review ${name}${r.note_for_team ? `: ${r.note_for_team}` : ""}`, invoice.period_on ?? deps.today);
    return { recurring: r, invoice, outcome: "draft" };
  }
  let stripe: Stripe;
  try {
    stripe = deps.stripe();
  } catch (e) {
    await task(`Could not send ${name}: ${(e as Error).message}`);
    return { recurring: r, invoice, outcome: "failed", message: (e as Error).message };
  }
  const opts = { timeZone: deps.timeZone };
  let sent = await sendInvoice(db, stripe, invoice.id, by, { ...opts, collect: r.mode === "charge" ? "charge" : "email" });
  // No card yet: emailed to pay, as the recurring invoice says ("emailed to pay until one is on file").
  if (!sent.ok && sent.reason === "no_card") {
    sent = await sendInvoice(db, stripe, invoice.id, by, { ...opts, collect: "email" });
    if (sent.ok) return { recurring: r, invoice: sent.invoice, outcome: "emailed", message: "no card on file" };
  }
  if (sent.ok) return { recurring: r, invoice: sent.invoice, outcome: r.mode === "charge" ? "charged" : "sent" };
  const verb = r.mode === "charge" ? "charge" : "send";
  const next = sent.reason === "declined" || sent.reason === "action" ? " Email them the payment page from the invoice." : " Send it from the invoice.";
  await task(`Could not ${verb} ${name}: ${sent.message}${next}`);
  return { recurring: r, invoice: (await invoiceById(db, invoice.id)) ?? invoice, outcome: "failed", message: sent.message };
}

/** Make due periods for one recurring invoice and act on each. `force` makes just the next one now. */
async function makeAndAct(db: Db, id: string, deps: RunDeps, opts: { force?: boolean; act?: boolean; late?: boolean }): Promise<Made[]> {
  const out: Made[] = [];
  const by = deps.by ?? "Recurring invoices";
  // A guard, not a limit anyone meets: a daily plan three years behind.
  for (let i = 0; i < 1200; i++) {
    const m = await makeNext(db, id, deps.today, !!opts.force, by);
    if (!m) break;
    if (m.invoiceId) {
      const [r, invoice] = await Promise.all([recurringById(db, id), invoiceById(db, m.invoiceId)]);
      const late = opts.late !== false && daysBetween(m.period, deps.today) > LATE_DAYS;
      out.push(opts.act === false ? { recurring: r!, invoice: invoice!, outcome: "draft" } : await act(db, r!, invoice!, deps, late));
    }
    if (opts.force) break;
  }
  return out;
}

export type RunResult = { made: number; drafts: number; sent: number; charged: number; emailed: number; failed: number; ended: number; errors: string[] };

/**
 * The daily run: every active recurring invoice's due periods, made and
 * acted on; then each active one is stamped `checked_at`, so its page can
 * tell when the run stopped. Safe to run twice: a period is made once.
 */
export async function runRecurring(db: Db, deps: RunDeps): Promise<RunResult> {
  const res: RunResult = { made: 0, drafts: 0, sent: 0, charged: 0, emailed: 0, failed: 0, ended: 0, errors: [] };
  // A proposal said no, by whatever path: its pending one never starts.
  const [ended, declined] = await db.transaction([endFinished(), q`
    update recurring_invoices r set status = 'ended', updated_at = now()
    where r.status = 'pending' and exists (select 1 from quotes qt where qt.id = r.quote_id and qt.status = 'declined')
    returning r.id`]);
  res.ended += ended.length + declined.length;
  const due = await db.sql<{ id: string }>`
    select id::text as id from recurring_invoices
    where status = 'active' and next_on - case when mode = 'draft' then days_ahead else 0 end <= ${deps.today}::date
    order by next_on, id`;
  for (const { id } of due) {
    try {
      for (const m of await makeAndAct(db, id, deps, {})) {
        res.made++;
        if (m.outcome === "draft") res.drafts++;
        else if (m.outcome === "sent") res.sent++;
        else if (m.outcome === "charged") res.charged++;
        else if (m.outcome === "emailed") res.emailed++;
        else {
          res.failed++;
          res.errors.push(`recurring #${id}, invoice #${m.invoice.id}: ${m.message}`);
        }
      }
    } catch (e) {
      res.failed++;
      res.errors.push(`recurring #${id}: ${(e as Error).message}`);
    }
  }
  const [after] = await db.transaction([endFinished()]);
  res.ended += after.length;
  await db.sql`update recurring_invoices set checked_at = now() where status = 'active'`;
  return res;
}

/** "Make this period's invoice now": the next period's invoice as a draft, whatever its date, for a person to look at and send. */
export async function makeNow(db: Db, id: string, deps: RunDeps): Promise<Invoice | null> {
  const [m] = await makeAndAct(db, id, deps, { force: true, act: false });
  return m?.invoice ?? null;
}

/**
 * A quote's yes (signed, or marked accepted): its pending recurring invoice
 * starts. When its first date has come, that first invoice is made at once
 * and acted on as its mode says (the yes is the go-ahead, so never late);
 * the run carries on from the next date to come.
 */
export async function startFromQuote(db: Db, quoteId: string, deps: RunDeps): Promise<{ recurring: Recurring; first: Made | null }[]> {
  const started = await db.sql<{ id: string }>`
    update recurring_invoices set status = 'active', updated_by = ${deps.by ?? "Recurring invoices"}, updated_at = now()
    where quote_id = ${quoteId}::bigint and status = 'pending' returning id::text as id`;
  const out: { recurring: Recurring; first: Made | null }[] = [];
  for (const { id } of started) {
    const r = (await recurringById(db, id))!;
    const first = r.first_on <= deps.today ? (await makeAndAct(db, id, deps, { force: true, late: false }))[0] ?? null : null;
    await skipPast(db, id, deps.today);
    out.push({ recurring: (await recurringById(db, id))!, first });
  }
  return out;
}

/** The quote was declined or expired: its pending recurring invoice never starts. */
export async function endForQuote(db: Db, quoteId: string, by: string): Promise<void> {
  await db.sql`update recurring_invoices set status = 'ended', updated_by = ${by}, updated_at = now() where quote_id = ${quoteId}::bigint and status = 'pending'`;
}

export const toRecurring = (r: Record<string, any>): Recurring => ({
  id: String(r.id),
  email: r.email,
  name: r.name ?? null,
  phone: r.phone ?? null,
  address: r.address ?? null,
  title: r.title,
  currency: r.currency,
  subtotal_cents: String(r.subtotal_cents),
  tax_cents: String(r.tax_cents),
  total_cents: String(r.total_cents),
  unit: r.unit,
  every: Number(r.every),
  first_on: r.first_day,
  next_n: Number(r.next_n),
  next_on: r.next_day,
  ends_on: r.ends_day ?? null,
  ends_after: r.ends_after == null ? null : Number(r.ends_after),
  made: Number(r.made),
  mode: r.mode,
  days_ahead: Number(r.days_ahead),
  days_until_due: Number(r.days_until_due),
  notes: r.notes ?? null,
  note_for_team: r.note_for_team ?? null,
  owner: r.owner ?? null,
  status: r.status,
  quote_id: r.quote_id == null ? null : String(r.quote_id),
  checked_at: r.checked_at ? new Date(r.checked_at) : null,
  source: r.source ?? null,
  created_by: r.created_by ?? null,
  updated_by: r.updated_by ?? null,
  created_at: new Date(r.created_at),
  updated_at: new Date(r.updated_at),
});

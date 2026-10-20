// The team's recurring invoices, under the invoices pages (invoicesAdmin
// mounts them): the list with the daily run's health, the form, a recurring
// invoice's page and what can be done to it; and a customer's saved cards
// (which one is charged, remove one). Every change is a POST from a page that
// says what will happen; a GET changes nothing.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Child } from "hono/jsx";
import { FieldList, Section } from "../admin/detail";
import { alertClass } from "../admin/flash";
import type { TeamVars } from "../admin/guard";
import type { Head } from "../admin/layout";
import { DataTable, EmptyState, SetupNeeded, When, type TableSpec } from "../admin/list";
import { idParam, localPath, str } from "../admin/query";
import { controlClass, fieldClass, primaryClass, Select, StatusBadge, type StatusOption } from "../admin/status";
import type { GetDb } from "../data/db";
import { formatMoney } from "../payments/money";
import { StripeError, type Stripe } from "../payments/stripe";
import { taxRates, type TaxRate } from "../payments/tax";
import { cardName, cardsFor, removeCard, syncCards, useCard, type Card } from "./cards";
import { addDays, todayIn } from "./document";
import { CustomerFields, formLines, LineItems, linesOf, OneOrRepeats, type FormLine } from "./form";
import { discardInvoice, invoiceById, INVOICE_STATUS_LABELS, type Invoice } from "./invoices";
import type { Errors, SavedLine } from "./lines";
import { isEditable, quoteById } from "./quotes";
import {
  createRecurring, describe, endRecurring, invoicesOf, lastRun, makeNow, MODE_LABELS, MODES, pastText, pauseRecurring, periodLabel, recurringById, recurringList,
  RECURRING_STATUS_LABELS, resumeRecurring, saveRecurring, scheduleText, shortDay, UNITS, type Recurring, type RecurringFields,
} from "./recurring";

type Ctx = Context<{ Variables: TeamVars }>;

/** What the invoices pages hand these routes. */
export type RecurringHelpers = {
  getDb: GetDb;
  base: string;
  timeZone: string;
  currency: string;
  daysUntilDue: number;
  source: string;
  framed: (c: Ctx, current: string, head: string | Head, body: Child, status?: number) => Response | Promise<Response>;
  back: (c: Ctx, path: string, code: string) => Response;
  stripeOf: (c: Ctx) => Stripe;
  More: (p: { items: Child[] }) => Child;
  Lines: (p: { qt: { currency: string; subtotal_cents: string; total_cents: string; lines: SavedLine[] }; rates: TaxRate[] }) => Child;
  menuItem: string;
  menuButton: string;
  /** The customer's record in the app, for Details. */
  customerHref?: (c: Ctx, email: string) => Promise<string | null>;
  /** A recurring invoice on a quote changed: the app re-makes what the quote shows (the CRM's proposal page). */
  quoteChanged?: (c: Ctx, quoteId: string) => Promise<void>;
  word: string;
};

export const RECURRING_OPTIONS: StatusOption[] = (["pending", "active", "paused", "ended"] as const).map((s) => ({
  value: s, label: RECURRING_STATUS_LABELS[s], tone: s === "active" ? "accent" : s === "pending" ? "strong" : s === "paused" ? "neutral" : "muted",
}));

export const RECURRING_MESSAGES: Record<string, string> = {
  "recurring-created": "Recurring invoice made. Its invoices are made on their dates.",
  "recurring-pending": "Attached: it starts when they say yes.",
  "recurring-paused": "Paused. Nothing is made until you resume it.",
  "recurring-resumed": "Resumed from the next date to come.",
  "recurring-ended": "Ended. The invoices it made stay.",
  "recurring-made": "The next invoice is made as a draft: check it and send it.",
  "recurring-none": "Nothing to make: it has ended or is not active.",
  "card-default": "That card is the one charged now.",
  "card-removed": "Card removed from their Stripe customer.",
  "cards-refreshed": "Cards read from Stripe.",
  "card-not-now": "That card is no longer on file.",
  "cards-stripe": "Stripe refused that, so nothing changed. Check Stripe for cards to see what is on file now.",
};

type RV = {
  email: string; name: string; phone: string; address: string; currency: string; title: string; unit: string; every: string; first_on: string;
  ends: string; ends_on: string; ends_after: string; mode: string; days_ahead: string; days_until_due: string; notes: string; note_for_team: string;
  owner: string; quote_id: string; lines: FormLine[];
  /** Make it repeat: the draft this one replaces, discarded once it is saved. */
  from_invoice?: string;
};

const readRV = (b: Record<string, unknown>): RV => ({
  email: str(b.email), name: str(b.name), phone: str(b.phone), address: str(b.address), currency: str(b.currency), title: str(b.title),
  // "period", not "unit": each line's price is the form's "unit".
  unit: str(b.period), every: str(b.every), first_on: str(b.first_on), ends: str(b.ends), ends_on: str(b.ends_on), ends_after: str(b.ends_after),
  mode: str(b.mode), days_ahead: str(b.days_ahead), days_until_due: str(b.days_until_due), notes: str(b.notes), note_for_team: str(b.note_for_team),
  owner: str(b.owner), quote_id: str(b.quote_id), lines: formLines(b), from_invoice: str(b.from_invoice),
});

const fields = (v: RV): RecurringFields => ({ ...v });

const valuesOf = (r: Recurring & { lines: SavedLine[] }): RV => ({
  email: r.email, name: r.name ?? "", phone: r.phone ?? "", address: r.address ?? "", currency: r.currency, title: r.title, unit: r.unit,
  every: String(r.every), first_on: r.first_on, ends: r.ends_after ? "after" : r.ends_on ? "on" : "never", ends_on: r.ends_on ?? "",
  ends_after: r.ends_after ? String(r.ends_after) : "", mode: r.mode, days_ahead: String(r.days_ahead), days_until_due: String(r.days_until_due),
  notes: r.notes ?? "", note_for_team: r.note_for_team ?? "", owner: r.owner ?? "", quote_id: r.quote_id ?? "", lines: linesOf(r),
});

function RecurringForm({ action, v, errors, rates, cancel, submit, taxPage, timeZone, fixed }: {
  action: string; v: RV; errors: Errors; rates: TaxRate[]; cancel: string; submit: string; taxPage: string; timeZone: string;
  /** Its schedule is set: an invoice is made. */
  fixed: boolean;
}) {
  const err = (k: string) => (errors[k] ? <span class="text-ink">{errors[k]}</span> : null);
  const problems = Object.keys(errors).length;
  const radio = (name: string, value: string, current: string) => ({ type: "radio", name, value, checked: current === value, class: "size-4" });
  return (
    <form method="post" action={action} class="flex flex-col gap-4">
      {problems ? <p role="alert" class={alertClass}>Fix what is marked below. Nothing was saved.</p> : null}
      {errors.status ? <p role="alert" class={alertClass}>{errors.status}</p> : null}
      {timeZone === "UTC" ? (
        <p role="status" class={alertClass}>Dates are in UTC. Set your time zone first, so each invoice is made on your date.</p>
      ) : null}
      <input type="hidden" name="quote_id" value={v.quote_id} />
      {v.from_invoice ? <input type="hidden" name="from_invoice" value={v.from_invoice} /> : null}
      <input type="hidden" name="currency" value={v.currency} />
      <CustomerFields v={v} errors={errors} />
      <Section title="Schedule">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class={fieldClass + " sm:col-span-2"}>Name<input name="title" required value={v.title} maxlength={200} placeholder="Maintenance plan" class={controlClass} />{err("title")}</label>
          <div class={fieldClass}>
            <span>How often</span>
            <div class="flex items-center gap-2">
              <span class="text-ink-2">Every</span>
              <input name="every" value={v.every || "1"} inputmode="numeric" maxlength={2} disabled={fixed} aria-label="Every how many" class={controlClass + " w-16"} />
              <Select name="period" disabled={fixed} aria-label="Weeks, months or years">
                {UNITS.map((u) => <option value={u} selected={(v.unit || "month") === u}>{u}s</option>)}
              </Select>
            </div>
            {fixed ? (
              <>
                <input type="hidden" name="every" value={v.every} />
                <input type="hidden" name="period" value={v.unit} />
              </>
            ) : null}
            {err("every")}{err("unit")}
          </div>
          <label class={fieldClass}>First invoice on
            <input name="first_on" type="date" required value={v.first_on} readonly={fixed} class={controlClass} />
            <span class="text-label text-ink-3">{fixed ? "Set once its first invoice is made." : "Its day is every invoice's day: the 1st to the 28th for months and years."}</span>
            {err("first_on")}
          </label>
          <fieldset class={fieldClass + " sm:col-span-2"}>
            <legend class="mb-1">Ends</legend>
            <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
              <label class="flex items-center gap-2"><input {...radio("ends", "never", v.ends || "never")} /> Never</label>
              <label class="flex items-center gap-2"><input {...radio("ends", "on", v.ends)} /> On
                <input name="ends_on" type="date" value={v.ends_on} aria-label="The last date" class={controlClass} /></label>
              <label class="flex items-center gap-2"><input {...radio("ends", "after", v.ends)} /> After
                <input name="ends_after" value={v.ends_after} inputmode="numeric" maxlength={4} aria-label="How many invoices" class={controlClass + " w-20"} /> invoices</label>
            </div>
            {err("ends")}{err("ends_on")}{err("ends_after")}
          </fieldset>
        </div>
      </Section>
      <LineItems lines={v.lines} errors={errors} rates={rates} taxPage={taxPage} />
      <Section title="On each date">
        <fieldset class="flex flex-col gap-2">
          <legend class="sr-only">What happens on each date</legend>
          {MODES.map((m) => (
            <label class="flex items-start gap-2">
              <input {...radio("mode", m, v.mode || "send")} class="mt-1 size-4" />
              <span>
                <span class="font-medium">{MODE_LABELS[m]}</span>
                <span class="block text-label text-ink-3">
                  {m === "draft" ? "For an amount that changes. The draft is made a few days early with a task to finish and send it."
                    : m === "send" ? "Stripe emails the invoice and they pay on its page."
                    : "Stripe charges the card they saved. Until they have one, it is emailed to pay; paying it on Stripe's page saves their card."}
                </span>
              </span>
            </label>
          ))}
          {err("mode")}
        </fieldset>
        <div class="mt-4 grid gap-3 sm:grid-cols-2">
          <label class={fieldClass}>For a draft: made (days before)<input name="days_ahead" value={v.days_ahead || "3"} inputmode="numeric" maxlength={2} class={controlClass} />{err("days_ahead")}</label>
          <label class={fieldClass}>Payment due in (days)<input name="days_until_due" value={v.days_until_due} inputmode="numeric" maxlength={3} class={controlClass} />{err("days_until_due")}</label>
          <label class={fieldClass + " sm:col-span-2"}>Message to the customer<textarea name="notes" rows={2} maxlength={5000} class={controlClass}>{v.notes}</textarea>{err("notes")}</label>
          <label class={fieldClass}>Note for the team, on its task<input name="note_for_team" value={v.note_for_team} maxlength={1000} placeholder="Add 12% of ad spend" class={controlClass} />{err("note_for_team")}</label>
          <label class={fieldClass}>Who gets its tasks<input name="owner" value={v.owner} maxlength={200} class={controlClass} />{err("owner")}</label>
        </div>
      </Section>
      <div class="flex flex-wrap items-center gap-3">
        <button class={primaryClass}>{submit}</button>
        <a href={cancel} class="text-label text-ink-2">Cancel</a>
      </div>
    </form>
  );
}

/** A customer's saved cards, with which is charged and the buttons to change that; for their page in the app. */
export function CardsOnFile({ cards, base, back, email }: { cards: Card[]; base: string; back: string; email: string }) {
  const post = (path: string, label: string, ask?: string) => (
    <form method="post" action={`${base}/cards/${path}`} class="inline" onsubmit={ask ? `return confirm(${JSON.stringify(ask)})` : undefined}>
      <input type="hidden" name="back" value={back} />
      <input type="hidden" name="email" value={email} />
      <button class="text-label text-ink-2 underline">{label}</button>
    </form>
  );
  return (
    <div>
      {cards.length ? (
        <ul class="flex flex-col divide-y divide-line">
          {cards.map((card) => (
            <li class="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                {cardName(card)}
                <span class="text-label text-ink-3">
                  {card.exp_month && card.exp_year ? ` · expires ${String(card.exp_month).padStart(2, "0")}/${String(card.exp_year).slice(-2)}` : ""}
                  {card.livemode ? "" : " · test mode"}
                  {card.isDefault ? " · used for automatic charges" : ""}
                </span>
              </span>
              <span class="flex items-center gap-3">
                {card.isDefault ? null : post(`${card.id}/default`, "Use for automatic charges")}
                {post(`${card.id}/remove`, "Remove", `Remove ${cardName(card)} from their Stripe customer? It cannot be added back; they save it again by paying on Stripe's page.`)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p class="text-ink-3">No card on file. A card is saved when they pay an invoice on Stripe's page.</p>
      )}
      <div class="mt-2">{post("refresh", "Check Stripe for cards")}</div>
    </div>
  );
}

/** A customer's recurring invoices, one line each, for their page in the app. */
export function RecurringLines({ list, base, card }: { list: Recurring[]; base: string; card: string | null }) {
  return (
    <ul class="flex flex-col divide-y divide-line">
      {list.map((r) => (
        <li class="py-2">
          <a href={`${base}/recurring/${r.id}`} class="font-medium">{r.title}</a>
          <span class="text-label text-ink-3"> · {RECURRING_STATUS_LABELS[r.status]}</span>
          <span class="block text-label text-ink-2">
            {r.status === "active" ? `Next: ${shortDay(r.next_on)}, ${formatMoney(r.total_cents, r.currency)}, ${r.mode === "charge" ? (card ? `charged to ${card}` : "charged to their card (none on file yet)") : r.mode === "send" ? "emailed to pay" : "a draft to review"}`
              : r.status === "pending" ? "Starts when its proposal is accepted" : `${formatMoney(r.total_cents, r.currency)} ${scheduleText(r)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function recurringRoutes(app: Hono<{ Variables: TeamVars }>, h: RecurringHelpers) {
  const base = `${h.base}/recurring`;
  const money = (c: string | number, cur: string) => formatMoney(c, cur);
  const today = () => todayIn(h.timeZone);
  const deps = (c: Ctx) => ({ today: today(), timeZone: h.timeZone, stripe: () => h.stripeOf(c), by: c.get("user") });

  const spec: TableSpec<Recurring> = {
    id: "recurring",
    href: (r) => `${base}/${r.id}`,
    columns: [
      { label: "Customer", cell: (r) => r.name ?? r.email },
      { label: "Name", cell: (r) => r.title, class: "hidden sm:table-cell" },
      { label: "Amount", cell: (r) => money(r.total_cents, r.currency), class: "text-right" },
      { label: "How often", cell: (r) => scheduleText(r), class: "hidden md:table-cell" },
      { label: "Next", cell: (r) => (r.status === "active" ? shortDay(r.next_on) : "") },
      { label: "On each date", cell: (r) => MODE_LABELS[r.mode], class: "hidden lg:table-cell" },
      { label: "Status", cell: (r) => <StatusBadge value={r.status} options={RECURRING_OPTIONS} /> },
    ],
  };

  app.get("/recurring", async (c) => {
    const ended = c.req.query("ended") === "1";
    const rows = (await recurringList(h.getDb(c), { all: ended })).filter((r) => ended || r.status !== "ended");
    const run = await lastRun(h.getDb(c));
    // The run is a scheduled job only the AI can set up: when it has stopped, say so here rather than fail quietly.
    const stale = run.active > 0 && (!run.checked || Date.now() - run.checked.getTime() > 2 * 86_400_000);
    return h.framed(c, base, { title: "Recurring invoices", actions: <a href={`${base}/new`} class={primaryClass}>New recurring invoice</a> }, (
      <>
        {stale ? (
          <SetupNeeded title={run.checked ? "Recurring invoices have stopped being made" : "Recurring invoices are not being made yet"} ask="Set up the Recurring invoices job.">
            {run.checked ? <>They last ran <When at={run.checked} timeZone={h.timeZone} />. </> : null}
            A daily job in Task &amp; Tool makes each invoice on its date. Ask the AI to set it up, or check it on the app's Jobs tab.
          </SetupNeeded>
        ) : null}
        <DataTable spec={spec} caption="Recurring invoices, next date first" rows={rows} next={null} more={() => base}
          empty={<EmptyState title="No recurring invoices yet." action={<a href={`${base}/new`} class={primaryClass}>New recurring invoice</a>}>
            Bill a customer every week, month or year: a draft to review, emailed to pay, or charged to their card.
          </EmptyState>} />
        <p class="mt-3 text-label"><a href={ended ? base : `${base}?ended=1`}>{ended ? "Hide ended ones" : "Show ended ones too"}</a></p>
      </>
    ));
  });

  const editor = async (c: Ctx, p: { title: string; action: string; v: RV; errors: Errors; cancel: string; fixed: boolean }, status = 200) => {
    const rates = await taxRates(h.getDb(c));
    return h.framed(c, base, { title: p.title, back: { href: p.cancel, label: "Back" } }, (
      <>
      {p.action === base ? <OneOrRepeats base={h.base} repeats={true} query={new URL(c.req.url).search} /> : null}
      <RecurringForm action={p.action} v={p.v} errors={p.errors} rates={rates} cancel={p.cancel} submit={p.action === base ? "Save recurring invoice" : "Save"}
        taxPage={`${h.base}/tax-rates`} timeZone={h.timeZone} fixed={p.fixed} />
      </>
    ), status);
  };

  // Blank, from a customer's page (who), from a quote waiting for its answer (attached: it starts at their yes,
  // its lines to begin from), or Repeat this invoice (a draft's customer and lines, and its quote while that waits).
  app.get("/recurring/new", async (c) => {
    const qy = (k: string) => (c.req.query(k) ?? "").slice(0, 500);
    const db = h.getDb(c);
    const from = idParam(qy("invoice")) ? await invoiceById(db, qy("invoice")) : null;
    const quote = idParam(qy("quote") || from?.quote_id || "") ? await quoteById(db, qy("quote") || from!.quote_id!) : null;
    const on = quote && isEditable(quote) ? quote : null;
    const doc = from ?? on;
    const v: RV = {
      email: doc?.email ?? qy("email"), name: doc?.name ?? qy("name"), phone: doc?.phone ?? qy("phone"), address: doc?.address ?? qy("address"),
      currency: doc?.currency ?? h.currency, title: "", unit: "month", every: "1", first_on: "", ends: "never", ends_on: "", ends_after: "",
      mode: "send", days_ahead: "3", days_until_due: String(from?.days_until_due ?? h.daysUntilDue), notes: from?.notes ?? "", note_for_team: "", owner: "",
      quote_id: on?.id ?? "", lines: doc ? linesOf(doc) : [], from_invoice: from?.status === "draft" ? from.id : "",
    };
    const cancel = from ? `${h.base}/${from.id}` : on ? `${h.base}/quotes/${on.id}` : base;
    return editor(c, { title: from ? "Make it repeat" : on ? `New invoice for ${h.word.toLowerCase()} ${on.number}` : "New invoice", action: base, v, errors: {}, cancel, fixed: false });
  });

  app.post("/recurring", async (c) => {
    const v = readRV(await c.req.parseBody({ all: true }));
    const quote = idParam(v.quote_id) ? await quoteById(h.getDb(c), v.quote_id) : null;
    // A quote still waiting for its answer: this starts at its yes. One already accepted: now.
    const pending = quote && ["draft", "sent", "expired"].includes(quote.status) ? { quoteId: quote.id } : undefined;
    if (quote?.status === "declined") {
      return editor(c, { title: "New invoice", action: base, v: { ...v, quote_id: "" }, errors: { status: `${h.word} ${quote.number} was declined, so nothing starts at its yes. Save again to start this one on its own.` }, cancel: base, fixed: false }, 422);
    }
    const r = await createRecurring(h.getDb(c), fields(v), c.get("user"), h.source, { pending });
    if (!r.ok) return editor(c, { title: "New invoice", action: base, v, errors: r.errors, cancel: quote ? `${h.base}/quotes/${quote.id}` : base, fixed: false }, 422);
    if (quote?.status === "accepted") await h.getDb(c).sql`update recurring_invoices set quote_id = ${quote.id}::bigint where id = ${r.value.id}::bigint`;
    // Made from a draft (Make it repeat): the draft is replaced, so it is never sent as well.
    const from = idParam(v.from_invoice ?? "") ? await invoiceById(h.getDb(c), v.from_invoice!) : null;
    if (from && from.email.toLowerCase() === r.value.email.toLowerCase()) await discardInvoice(h.getDb(c), from.id, c.get("user"));
    if (pending) await h.quoteChanged?.(c, quote!.id);
    return pending ? h.back(c, `${h.base}/quotes/${quote!.id}`, "recurring-pending") : h.back(c, `${base}/${r.value.id}`, "recurring-created");
  });

  app.get("/recurring/:id{[0-9]+}", async (c) => {
    const r = await recurringById(h.getDb(c), c.req.param("id"));
    if (!r) return c.notFound();
    const self = `${base}/${r.id}`;
    const db = h.getDb(c);
    const [rates, invoices, cards, quote, customer] = await Promise.all([
      taxRates(db), invoicesOf(db, r.id), cardsFor(db, r.email), r.quote_id ? quoteById(db, r.quote_id) : null, h.customerHref?.(c, r.email) ?? null,
    ]);
    const card = cards.find((x) => x.isDefault && x.livemode) ?? cards.find((x) => x.isDefault) ?? null;
    const post = (path: string, label: string) => <form method="post" action={`${self}/${path}`}><button class={h.menuButton}>{label}</button></form>;
    const live = r.status !== "ended";
    return h.framed(c, base, {
      title: r.title,
      back: { href: base, label: "Recurring invoices" },
      sub: (
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge value={r.status} options={RECURRING_OPTIONS} />
          <span>{r.name ?? r.email} · {money(r.total_cents, r.currency)} {scheduleText(r)}</span>
        </p>
      ),
      actions: (
        <>
          {h.More({ items: [
            r.status === "active" ? post("make-now", `Make the next invoice now (${shortDay(r.next_on)})`) : null,
            r.status === "active" ? post("pause", "Pause") : null,
            r.status === "paused" ? post("resume", "Resume") : null,
            live ? <a href={`${self}/end`} class={h.menuItem}>End</a> : null,
          ] })}
          {live ? <a href={`${self}/edit`} class={primaryClass}>Edit</a> : null}
        </>
      ),
    }, (
      <div class="grid gap-4 md:grid-cols-3">
        <div class="flex min-w-0 flex-col gap-4 md:col-span-2">
          <Section title="What happens">
            <p class="max-w-prose">{describe(r, r.mode === "charge" && card ? cardName(card) : null)}</p>
            <p class="mt-2 text-ink-2">
              {r.status === "active" ? <>Next invoice: {r.mode === "draft" ? `a draft on ${shortDay(addDays(r.next_on, -r.days_ahead))}, for ` : ""}{periodLabel(r.unit, r.next_on)}{r.unit === "week" ? "" : ` (${shortDay(r.next_on)})`}.</>
                : r.status === "pending" ? <>Starts when {quote ? <a href={`${h.base}/quotes/${quote.id}`}>{h.word} {quote.number}</a> : "its quote"} is accepted.</>
                : r.status === "paused" ? "Paused: nothing is made until it is resumed, from the next date to come."
                : "Ended: no more invoices."}
            </p>
            {r.status === "active" && pastText(r, today()) ? <p role="alert" class={"mt-3 " + alertClass}>{pastText(r, today())}</p> : null}
            {r.mode === "charge" && !card ? <p class="mt-2 text-label text-ink-3">No card on file yet, so each invoice is emailed to pay until one is. Paying on Stripe's page saves their card.</p> : null}
          </Section>
          <Section title="Line items">{h.Lines({ qt: r, rates })}</Section>
          <Section title="Invoices it made" count={invoices.length}>
            {invoices.length ? (
              <ul class="flex flex-col divide-y divide-line">
                {invoices.map((i: Invoice) => (
                  <li class="flex items-center justify-between gap-3 py-2">
                    <a href={`${h.base}/${i.id}`}>{i.period_on ? periodLabel(r.unit, i.period_on) : `Invoice #${i.id}`}</a>
                    <span class="text-label text-ink-2">{INVOICE_STATUS_LABELS[i.status]}{i.payment_failed_at && i.status === "open" ? " · payment failed" : ""}</span>
                    <span class="tabular-nums">{money(i.total_cents, i.currency)}</span>
                  </li>
                ))}
              </ul>
            ) : <p class="text-ink-3">None yet.</p>}
          </Section>
        </div>
        <div class="flex flex-col gap-4">
          <Section title="Details">
            <FieldList fields={[
              { label: "Bill to", value: customer ? <a href={customer}>{r.name ?? r.email}</a> : r.name ?? r.email },
              { label: "Email", value: r.email },
              { label: "First invoice", value: shortDay(r.first_on) },
              { label: "Ends", value: r.ends_after ? `After ${r.ends_after} invoices (${r.made} made)` : r.ends_on ? shortDay(r.ends_on) : "Never" },
              { label: "On each date", value: MODE_LABELS[r.mode] },
              { label: "Payment due", value: r.mode === "charge" ? null : `${r.days_until_due} days after it is sent` },
              { label: "Card", value: r.mode === "charge" ? (card ? cardName(card) : "None on file yet") : null },
              { label: "Tasks go to", value: r.owner },
              { label: "Note for the team", value: r.note_for_team },
              { label: h.word, value: quote ? <a href={`${h.base}/quotes/${quote.id}`}>{h.word} {quote.number}</a> : null },
            ]} />
          </Section>
        </div>
      </div>
    ));
  });

  app.get("/recurring/:id{[0-9]+}/edit", async (c) => {
    const r = await recurringById(h.getDb(c), c.req.param("id"));
    if (!r) return c.notFound();
    if (r.status === "ended") return c.redirect(`${base}/${r.id}`, 302);
    return editor(c, { title: `Edit ${r.title}`, action: `${base}/${r.id}`, v: valuesOf(r), errors: {}, cancel: `${base}/${r.id}`, fixed: r.made > 0 });
  });

  app.post("/recurring/:id{[0-9]+}", async (c) => {
    const id = c.req.param("id");
    const now = await recurringById(h.getDb(c), id);
    if (!now) return c.notFound();
    const v = readRV(await c.req.parseBody({ all: true }));
    const r = await saveRecurring(h.getDb(c), id, fields(v), c.get("user"));
    if (!r.ok) return editor(c, { title: `Edit ${now.title}`, action: `${base}/${id}`, v, errors: r.errors, cancel: `${base}/${id}`, fixed: now.made > 0 }, 422);
    if (now.status === "pending" && now.quote_id) await h.quoteChanged?.(c, now.quote_id);
    return h.back(c, now.status === "pending" && now.quote_id ? `${h.base}/quotes/${now.quote_id}` : `${base}/${id}`, "saved");
  });

  // End says what it does first; the rest are plain, undoable or harmless.
  app.get("/recurring/:id{[0-9]+}/end", async (c) => {
    const r = await recurringById(h.getDb(c), c.req.param("id"));
    if (!r) return c.notFound();
    const self = `${base}/${r.id}`;
    return h.framed(c, base, { title: `End ${r.title}`, back: { href: self, label: r.title } }, (
      <Section title="What happens" class="max-w-2xl">
        <p class="mb-4 max-w-prose">No more invoices are made for {r.name ?? r.email}. The {r.made === 1 ? "invoice" : `${r.made} invoices`} it made stay as they are. It cannot be restarted; make a new one instead.</p>
        <form method="post" action={`${self}/end`} class="flex items-center gap-4">
          <button class={primaryClass}>End it</button>
          <a href={self} class="text-label text-ink-2">Cancel</a>
        </form>
      </Section>
    ));
  });

  for (const [path, done] of [["pause", "recurring-paused"], ["resume", "recurring-resumed"], ["end", "recurring-ended"], ["make-now", "recurring-made"]] as const) {
    app.post(`/recurring/:id{[0-9]+}/${path}`, async (c) => {
      const id = c.req.param("id");
      const db = h.getDb(c), by = c.get("user");
      if (path === "make-now") {
        const inv = await makeNow(db, id, deps(c));
        return inv ? h.back(c, `${h.base}/${inv.id}`, done) : h.back(c, `${base}/${id}`, "recurring-none");
      }
      const before = path === "end" ? await recurringById(db, id) : null;
      const ok = path === "pause" ? await pauseRecurring(db, id, by) : path === "resume" ? await resumeRecurring(db, id, by, today()) : await endRecurring(db, id, by);
      if (ok && before?.status === "pending" && before.quote_id) await h.quoteChanged?.(c, before.quote_id);
      return h.back(c, `${base}/${id}`, ok ? done : "not-now");
    });
  }

  // ---- a customer's cards -----------------------------------------------------

  // Back to the page it was pressed on: the customer's page is the app's, not under base.
  const backTo = (b: Record<string, unknown>) => localPath(str(b.back), "", base);
  app.post("/cards/refresh", async (c) => {
    const b = await c.req.parseBody();
    const db = h.getDb(c);
    const rows = await db.sql<{ stripe_customer_id: string; livemode: boolean }>`
      select stripe_customer_id, livemode from stripe_customers where email = ${str(b.email)}::citext`;
    try {
      for (const r of rows) await syncCards(db, h.stripeOf(c), r.stripe_customer_id, r.livemode);
    } catch (e) {
      if (e instanceof StripeError) return h.back(c, backTo(b), "cards-stripe");
      throw e;
    }
    return h.back(c, backTo(b), "cards-refreshed");
  });
  app.post("/cards/:pm{pm_[A-Za-z0-9_]+}/:act{default|remove}", async (c) => {
    const b = await c.req.parseBody();
    const pm = c.req.param("pm");
    let ok: boolean;
    try {
      ok = c.req.param("act") === "default" ? await useCard(h.getDb(c), h.stripeOf(c), pm) : await removeCard(h.getDb(c), h.stripeOf(c), pm);
    } catch (e) {
      // Already removed in Stripe, or Stripe unreachable: nothing changed here.
      if (e instanceof StripeError) return h.back(c, backTo(b), "cards-stripe");
      throw e;
    }
    return h.back(c, backTo(b), ok ? (c.req.param("act") === "default" ? "card-default" : "card-removed") : "card-not-now");
  });
}

// The private payments views, on the admin skill's pieces: a list with search
// and filters, a detail page, a CSV export, and a refund a signed-in team
// member confirms. There is no status form: status changes only from Stripe's
// webhook.
//
//   import { paymentsAdmin } from "./payments/admin";
//   app.route("/admin/payments", paymentsAdmin(getDb, {
//     base: "/admin/payments", css: "/site.css", timeZone: "America/Chicago", nav: NAV,
//   }));                                      // Stripe from stripeFrom(envOf(c)) unless `stripe` says otherwise
//
// Link to one booking's payments with `?ref_type=booking&ref_id=42`.
//
// A refund here is a person acting, not the AI: the guard puts a signed-in
// team member behind every request, the amount is confirmed on its own page,
// and the Idempotency-Key makes a double submit one refund. The row does not
// change to refunded here; Stripe's charge.refunded event does that.
import { Hono, type Context } from "hono";
import type { Db, GetDb } from "../data/db";
import { envOf } from "../data/env";
import { teamOnly, type TeamVars } from "../admin/guard";
import { AdminLayout, type NavItem } from "../admin/layout";
import { cut, everyPage, readCursor, type Cursor } from "../admin/keyset";
import { csvResponse, type CsvColumn } from "../admin/csv";
import { DataTable, SearchBar, TableRows, When, type TableSpec } from "../admin/list";
import { FieldList, Section } from "../admin/detail";
import { Flash, withFlash, type FlashMessages } from "../admin/flash";
import { idParam, isPartial, likePattern, listUrl, str } from "../admin/query";
import { buttonClass, controlClass, pickStatus, StatusBadge, type StatusOption } from "../admin/status";
import { decimals, formatMoney, toMinor } from "./money";
import { StripeError, stripeFrom, type Stripe } from "./stripe";

export type PaymentsAdminOptions = {
  /** The Stripe caller for a refund; default stripeFrom(envOf(c)). */
  stripe?: (c: Context) => Stripe;
  /** Where it is mounted, e.g. "/admin/payments". */
  base: string;
  css: string;
  /** The business's IANA zone; times show in it. */
  timeZone: string;
  nav?: NavItem[];
  pageSize?: number;
};

export type Payment = {
  id: string;
  email: string | null;
  name: string | null;
  amount_cents: string;
  currency: string;
  status: string;
  kind: string;
  ref_type: string | null;
  ref_id: string | null;
  description: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  refunded_cents: string;
  livemode: boolean | null;
  source: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
  k: string;
};

export const STATUSES: StatusOption[] = [
  { value: "paid", label: "Paid", tone: "accent" },
  { value: "pending", label: "Pending", tone: "strong" },
  { value: "partially_refunded", label: "Partly refunded", tone: "neutral" },
  { value: "refunded", label: "Refunded", tone: "neutral" },
  { value: "failed", label: "Failed", tone: "muted" },
  { value: "cancelled", label: "Cancelled", tone: "muted" },
];
const KINDS: StatusOption[] = [
  { value: "deposit", label: "Deposit" },
  { value: "full", label: "Full" },
  { value: "invoice", label: "Invoice" },
  { value: "other", label: "Other" },
];

const MESSAGES: FlashMessages = {
  refund: "Refund requested. The status changes when Stripe confirms it, usually within a minute.",
};

export type Filters = { q: string | null; status: string | null; kind: string | null; refType: string | null; refId: string | null };

export function readFilters(c: Context): Filters {
  const text = (name: string) => (c.req.query(name) ?? "").trim().slice(0, 200) || null;
  return {
    q: text("q"),
    status: pickStatus(c.req.query("status"), STATUSES),
    kind: pickStatus(c.req.query("kind"), KINDS),
    refType: text("ref_type"),
    refId: text("ref_id"),
  };
}

const params = (f: Filters) => ({ q: f.q, status: f.status, kind: f.kind, ref_type: f.refType, ref_id: f.refId });

/** One page plus one row, newest first, after the cursor. */
export function listPayments(db: Db, f: Filters, after: Cursor | null, size: number): Promise<Payment[]> {
  const pat = likePattern(f.q);
  return db.sql<Payment>`
    select p.*, p.created_at::text as k from payments p
    where (${pat}::text is null or p.email::text ilike ${pat} or p.name ilike ${pat})
      and (${f.status}::text is null or p.status = ${f.status})
      and (${f.kind}::text is null or p.kind = ${f.kind})
      and (${f.refType}::text is null or p.ref_type = ${f.refType})
      and (${f.refId}::text is null or p.ref_id = ${f.refId})
      and (${after?.k ?? null}::timestamptz is null
           or (p.created_at, p.id) < (${after?.k ?? null}::timestamptz, ${after?.id ?? null}::bigint))
    order by p.created_at desc, p.id desc
    limit ${size + 1}`;
}

const major = (minor: number | string, currency: string) => (Number(minor) / 10 ** decimals(currency)).toFixed(decimals(currency));

const CSV: CsvColumn<Payment>[] = [
  { label: "ID", value: (p) => p.id },
  { label: "Created (UTC)", value: (p) => p.created_at },
  { label: "Paid (UTC)", value: (p) => p.paid_at },
  { label: "Email", value: (p) => p.email },
  { label: "Name", value: (p) => p.name },
  { label: "Kind", value: (p) => p.kind },
  { label: "Status", value: (p) => p.status },
  { label: "Currency", value: (p) => p.currency },
  // Major units for a spreadsheet; the minor-unit integer stays in the database.
  { label: "Amount", value: (p) => major(p.amount_cents, p.currency) },
  { label: "Refunded", value: (p) => major(p.refunded_cents, p.currency) },
  { label: "For", value: (p) => p.ref_type },
  { label: "Ref", value: (p) => p.ref_id },
  { label: "Description", value: (p) => p.description },
  { label: "Test mode", value: (p) => (p.livemode === false ? "yes" : "") },
  { label: "Stripe payment", value: (p) => p.stripe_payment_intent_id },
];

const remaining = (p: Payment) => Number(p.amount_cents) - Number(p.refunded_cents);
const refundable = (p: Payment) => (p.status === "paid" || p.status === "partially_refunded") && !!p.stripe_payment_intent_id && remaining(p) > 0;

function whyNotRefundable(p: Payment): string {
  if (p.status === "refunded") return "Refunded in full.";
  if (p.status !== "paid" && p.status !== "partially_refunded") return "Only a paid payment can be refunded.";
  if (!p.stripe_payment_intent_id) return "Stripe has not confirmed this payment yet. Try again in a minute.";
  return "Nothing is left to refund.";
}

function Status({ p }: { p: Payment }) {
  return (
    <span class="inline-flex flex-wrap gap-1">
      <StatusBadge value={p.status} options={STATUSES} />
      {p.livemode === false ? <StatusBadge value="test" options={[{ value: "test", label: "Test", tone: "muted" }]} /> : null}
    </span>
  );
}

export function paymentsAdmin(getDb: GetDb, opts: PaymentsAdminOptions) {
  const stripe = opts.stripe ?? ((c: Context) => stripeFrom(envOf(c)));
  const base = opts.base.replace(/\/+$/, "");
  const size = opts.pageSize ?? 50;
  const nav = opts.nav ?? [{ href: base, label: "Payments" }];
  const tz = opts.timeZone;
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());

  const spec: TableSpec<Payment> = {
    id: "payments",
    href: (p) => `${base}/${p.id}`,
    columns: [
      { label: "Date", cell: (p) => <When at={p.created_at} timeZone={tz} /> },
      { label: "Email", cell: (p) => p.email ?? "Not given" },
      { label: "For", cell: (p) => (p.ref_type ? `${p.ref_type} ${p.ref_id ?? ""}` : ""), class: "hidden md:table-cell" },
      { label: "Kind", cell: (p) => KINDS.find((k) => k.value === p.kind)?.label ?? p.kind, class: "hidden sm:table-cell" },
      { label: "Amount", cell: (p) => formatMoney(p.amount_cents, p.currency), class: "text-right tabular-nums" },
      { label: "Status", cell: (p) => <Status p={p} /> },
    ],
  };

  app.get("/", async (c) => {
    const f = readFilters(c);
    const after = readCursor(c.req.query("after"));
    const { page, next } = cut(await listPayments(getDb(c), f, after, size), size);
    const self = listUrl(base, params(f));
    const more = (cur: string) => listUrl(base, { ...params(f), after: cur });
    if (isPartial(c) && after) return c.html(<TableRows spec={spec} rows={page} next={next} more={more} />);

    const filtered = f.q || f.status || f.kind || f.refType || f.refId;
    const results = (
      <div id="results">
        {f.refType || f.refId ? (
          <p class="mb-3 text-label">
            Payments for {f.refType ?? "anything"} {f.refId ?? ""}. <a href={listUrl(base, { ...params(f), ref_type: null, ref_id: null })}>Show all</a>
          </p>
        ) : null}
        {after ? (
          <p class="mb-3 text-label">
            <a href={self}>Back to the newest</a>
          </p>
        ) : null}
        <DataTable
          spec={spec}
          caption="Payments, newest first"
          rows={page}
          next={next}
          more={more}
          empty={
            filtered ? (
              <>
                No payments match these filters. <a href={base}>Clear filters</a>
              </>
            ) : (
              "No payments yet."
            )
          }
        />
        <p class="mt-3 text-label">
          <a href={listUrl(`${base}/export.csv`, params(f))}>Export these as CSV</a>
        </p>
      </div>
    );
    if (isPartial(c)) return c.html(results);
    return c.html(
      <AdminLayout title="Payments" css={opts.css} nav={nav} current={base} user={c.get("user")}>
        <SearchBar
          action={base}
          target="#results"
          q={f.q}
          placeholder="Email or name"
          filters={[
            { name: "status", label: "Status", options: STATUSES, value: f.status, any: "Any status" },
            { name: "kind", label: "Kind", options: KINDS, value: f.kind, any: "Any kind" },
          ]}
        />
        {results}
      </AdminLayout>,
    );
  });

  app.get("/export.csv", (c) => {
    const day = new Date().toISOString().slice(0, 10);
    const db = getDb(c);
    const f = readFilters(c);
    return csvResponse(`payments-${day}.csv`, CSV, everyPage((after, size) => listPayments(db, f, after, size)));
  });

  async function load(c: Context): Promise<Payment | null> {
    const id = idParam(c.req.param("id"));
    if (!id) return null;
    const [p] = await getDb(c).sql<Payment>`select p.*, p.created_at::text as k from payments p where p.id = ${id}::bigint`;
    return p ?? null;
  }

  app.get("/:id", async (c) => {
    const p = await load(c);
    if (!p) return c.notFound();
    const events = await getDb(c).sql<{ id: string; type: string; received_at: Date }>`
      select id, type, received_at from stripe_events where payment_id = ${p.id}::bigint order by received_at`;
    return c.html(
      <AdminLayout title={`Payment ${p.id}`} css={opts.css} nav={nav} current={base} user={c.get("user")}>
        <p class="mb-4 text-label">
          <a href={base}>All payments</a>
        </p>
        <Flash code={c.req.query("saved")} messages={MESSAGES} />
        <div class="grid gap-4 md:grid-cols-3">
          <Section title="Details" class="md:col-span-2">
            <FieldList
              fields={[
                { label: "Status", value: <Status p={p} /> },
                { label: "Amount", value: formatMoney(p.amount_cents, p.currency) },
                { label: "Refunded", value: Number(p.refunded_cents) ? formatMoney(p.refunded_cents, p.currency) : null },
                { label: "Kind", value: KINDS.find((k) => k.value === p.kind)?.label ?? p.kind },
                {
                  label: "For",
                  value: p.ref_type ? <a href={listUrl(base, { ref_type: p.ref_type, ref_id: p.ref_id })}>{`${p.ref_type} ${p.ref_id ?? ""}`}</a> : null,
                },
                { label: "Email", value: p.email },
                { label: "Name", value: p.name },
                { label: "Description", value: p.description },
                { label: "Created", value: <When at={p.created_at} timeZone={tz} /> },
                { label: "Paid", value: <When at={p.paid_at} timeZone={tz} /> },
                { label: "From", value: p.source },
                { label: "Last changed by", value: p.updated_by },
                { label: "Stripe payment", value: p.stripe_payment_intent_id },
                { label: "Checkout session", value: p.stripe_checkout_session_id },
              ]}
            />
          </Section>
          <div class="flex flex-col gap-4">
            <Section title="Refund">
              {refundable(p) ? (
                <a href={`${base}/${p.id}/refund`} class={buttonClass + " inline-block no-underline"}>
                  Refund…
                </a>
              ) : (
                <p class="text-ink-2">{whyNotRefundable(p)}</p>
              )}
            </Section>
            <Section title="Stripe events">
              {events.length ? (
                <ol class="flex flex-col gap-2 text-label">
                  {events.map((e) => (
                    <li>
                      <When at={e.received_at} timeZone={tz} /> · {e.type}
                    </li>
                  ))}
                </ol>
              ) : (
                <p class="text-ink-3">None yet.</p>
              )}
            </Section>
          </div>
        </div>
      </AdminLayout>,
    );
  });

  const refundPage = (c: Context<{ Variables: TeamVars }>, p: Payment, amount: string, error?: string) =>
    c.html(
      <AdminLayout title={`Refund payment ${p.id}`} css={opts.css} nav={nav} current={base} user={c.get("user")}>
        <RefundForm p={p} base={base} amount={amount} error={error} />
      </AdminLayout>,
      error ? 422 : 200,
    );

  // The confirmation step: nothing moves money on a GET.
  app.get("/:id/refund", async (c) => {
    const p = await load(c);
    if (!p) return c.notFound();
    if (!refundable(p)) return c.redirect(`${base}/${p.id}`, 303);
    return refundPage(c, p, major(remaining(p), p.currency));
  });

  app.post("/:id/refund", async (c) => {
    const p = await load(c);
    if (!p) return c.notFound();
    if (!refundable(p)) return c.redirect(`${base}/${p.id}`, 303);
    const body = await c.req.parseBody();
    const typed = str(body.amount);

    // A refund recorded since the page opened changes what is left to refund.
    if (str(body.seen) !== String(p.refunded_cents)) return refundPage(c, p, typed, "A refund was recorded since this page opened. Check the amount and confirm again.");
    const amount = toMinor(typed, p.currency);
    if (amount === null || amount <= 0) return refundPage(c, p, typed, "Enter an amount, such as 25.00.");
    if (amount > remaining(p)) return refundPage(c, p, typed, `At most ${formatMoney(remaining(p), p.currency)} is left to refund.`);

    try {
      await stripe(c)(
        "POST",
        "/v1/refunds",
        { payment_intent: p.stripe_payment_intent_id, amount, metadata: { payment_id: p.id, requested_by: c.get("user") } },
        // Same payment, same refunded total, same amount: a double submit is one refund. The
        // payment intent, not the row id: keys are per Stripe account, which other projects may share.
        { idempotencyKey: `refund-${p.stripe_payment_intent_id}-${p.refunded_cents}-${amount}` },
      );
    } catch (e) {
      if (e instanceof StripeError) return refundPage(c, p, typed, `Stripe did not refund it: ${e.message}`);
      throw e;
    }
    await getDb(c).sql`update payments set updated_by = ${c.get("user")}, updated_at = now() where id = ${p.id}::bigint`;
    return c.redirect(withFlash(`${base}/${p.id}`, "refund"), 303);
  });

  return app;
}

function RefundForm({ p, base, amount, error }: { p: Payment; base: string; amount: string; error?: string }) {
  return (
    <form method="post" action={`${base}/${p.id}/refund`} class="flex max-w-md flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <p>
        This sends money back to {p.email ?? "the payer"} through Stripe. It cannot be undone. Paid {formatMoney(p.amount_cents, p.currency)}
        {Number(p.refunded_cents) ? `, already refunded ${formatMoney(p.refunded_cents, p.currency)}` : ""}.
      </p>
      <input type="hidden" name="seen" value={String(p.refunded_cents)} />
      <label for="amount" class="flex flex-col gap-1 text-label text-ink-2">
        Amount to refund ({p.currency.toUpperCase()})
        <input
          id="amount"
          name="amount"
          inputmode="decimal"
          required
          value={amount}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? "amount-error" : undefined}
          class={controlClass}
        />
      </label>
      {error ? (
        <p id="amount-error" class="text-label text-ink">
          {error}
        </p>
      ) : null}
      <div class="flex flex-wrap items-center gap-3">
        <button class={buttonClass}>Refund this amount</button>
        <a href={`${base}/${p.id}`} class="text-label text-ink-2">
          Keep the payment
        </a>
      </div>
    </form>
  );
}

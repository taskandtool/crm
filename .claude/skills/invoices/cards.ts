// The cards saved on a customer in the owner's Stripe account, and which one
// is charged. A card is saved by Stripe (the customer ticks "save" on a
// hosted invoice page, or the owner adds it in Stripe's Dashboard); this
// keeps a mirror of brand, last four and expiry, from Stripe's events and
// from `syncCards` before a charge, so a project whose webhook lacks the card
// events still charges the right card.
//
//   app.route("/", stripeWebhook(getDb, { more: [invoiceEvents, cardEvents] }));
//   const card = await chargeCard(db, stripe, "ann@example.com", livemode);   // null: none on file
//
// Which card is charged is ours, in the open: a customer's first card, until
// a person picks another (`useCard`) or the owner sets a default in Stripe
// (customer.updated). Saving never makes a card the one charged by itself
// in Stripe; the charge names the card.
import { q, type Db } from "../data/db";
import type { EventHandler, StripeEvent } from "../payments/webhook";
import type { Stripe } from "../payments/stripe";

export type Card = {
  id: string;
  customer: string;
  livemode: boolean;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  /** The one charged. */
  isDefault: boolean;
};

type StripeCard = { id: string; type?: string; customer?: string | null; livemode?: boolean; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } };

/** "Visa 4242". */
export const cardName = (c: Pick<Card, "brand" | "last4">): string =>
  `${c.brand ? c.brand.charAt(0).toUpperCase() + c.brand.slice(1).replace("_", " ") : "Card"} ${c.last4 ?? ""}`.trim();

const toCard = (r: Record<string, any>): Card => ({
  id: r.stripe_payment_method_id,
  customer: r.stripe_customer_id,
  livemode: r.livemode,
  brand: r.brand ?? null,
  last4: r.last4 ?? null,
  exp_month: r.exp_month == null ? null : Number(r.exp_month),
  exp_year: r.exp_year == null ? null : Number(r.exp_year),
  isDefault: r.is_default === true,
});

/** A customer's saved cards by email, the one charged first; live mode before test mode. */
export async function cardsFor(db: Db, email: string): Promise<Card[]> {
  const rows = await db.sql`
    select c.*, c.stripe_payment_method_id = s.default_card as is_default
    from stripe_cards c join stripe_customers s on s.stripe_customer_id = c.stripe_customer_id
    where s.email = ${email}::citext and c.detached_at is null
    order by c.livemode desc, (c.stripe_payment_method_id = s.default_card) desc nulls last, c.attached_at`;
  return rows.map(toCard);
}

/** The card a charge in this mode uses, or null when none is on file. */
export async function defaultCard(db: Db, email: string, livemode: boolean): Promise<Card | null> {
  return (await cardsFor(db, email)).find((c) => c.livemode === livemode && c.isDefault) ?? null;
}

// The customer's default: kept while it is a live card, else Stripe's own default
// when it is one of theirs, else their oldest card.
const pickDefault = (customer: string, stripeDefault: string | null) => q`
  update stripe_customers s set default_card = (
    select c.stripe_payment_method_id from stripe_cards c
    where c.stripe_customer_id = ${customer} and c.detached_at is null
    order by c.stripe_payment_method_id = ${stripeDefault}::text desc nulls last,
             c.stripe_payment_method_id = s.default_card desc nulls last, c.attached_at
    limit 1)
  where s.stripe_customer_id = ${customer}`;

// Only our customers' cards: an event for anyone else on the account changes nothing.
const upsert = (pm: StripeCard, customer: string) => q`
  insert into stripe_cards (stripe_payment_method_id, stripe_customer_id, livemode, brand, last4, exp_month, exp_year)
  select ${pm.id}, ${customer}, ${pm.livemode ?? false}, ${pm.card?.brand ?? null}, ${pm.card?.last4 ?? null},
         ${pm.card?.exp_month ?? null}::int, ${pm.card?.exp_year ?? null}::int
  where exists (select 1 from stripe_customers where stripe_customer_id = ${customer})
  on conflict (stripe_payment_method_id) do update set stripe_customer_id = excluded.stripe_customer_id, brand = excluded.brand,
    last4 = excluded.last4, exp_month = excluded.exp_month, exp_year = excluded.exp_year, detached_at = null`;

const CARD_EVENTS = new Set(["payment_method.attached", "payment_method.detached", "customer.updated"]);

/**
 * For the payments webhook's `more`: a card saved, removed, or chosen as the
 * customer's default in Stripe. Each event once (stripe_events), in one
 * transaction.
 */
export const cardEvents: EventHandler = {
  handles: (event) => CARD_EVENTS.has(event.type),
  apply: async (db, event: StripeEvent) => {
    const o = event.data?.object ?? {};
    const record = q`insert into stripe_events (id, type) values (${event.id}, ${event.type}) on conflict (id) do nothing`;
    if (event.type === "customer.updated") {
      // The owner chose a default in Stripe: ours follows when it is one of their cards. Once per event,
      // so a late redelivery of an older one never undoes a later choice.
      const customer = typeof o.id === "string" ? o.id : null;
      const def = typeof o.invoice_settings?.default_payment_method === "string" ? o.invoice_settings.default_payment_method : null;
      if (!customer || !def) return void (await db.transaction([record]));
      await db.transaction([q`
        with ev as (insert into stripe_events (id, type) values (${event.id}, ${event.type}) on conflict (id) do nothing returning id)
        update stripe_customers set default_card = ${def}
        where stripe_customer_id = ${customer} and exists (select 1 from ev)
          and exists (select 1 from stripe_cards c where c.stripe_payment_method_id = ${def} and c.stripe_customer_id = ${customer} and c.detached_at is null)`]);
      return;
    }
    if (o.type !== "card" || typeof o.id !== "string") return void (await db.transaction([record]));
    if (event.type === "payment_method.attached" && typeof o.customer === "string") {
      await db.transaction([record, upsert(o as StripeCard, o.customer), pickDefault(o.customer, null)]);
      return;
    }
    // Detached: Stripe's object no longer names the customer, so the card's row does.
    await db.transaction([
      record,
      q`update stripe_cards set detached_at = coalesce(detached_at, now()) where stripe_payment_method_id = ${o.id}`,
      q`update stripe_customers s set default_card = (
          select c.stripe_payment_method_id from stripe_cards c
          where c.stripe_customer_id = s.stripe_customer_id and c.detached_at is null order by c.attached_at limit 1)
        where s.default_card = ${o.id}`,
    ]);
  },
};

/**
 * Read a customer's cards from Stripe and make the mirror match: new ones
 * added, gone ones marked removed, the default kept or chosen. Before a
 * charge, and from the customer's page.
 */
export async function syncCards(db: Db, stripe: Stripe, customer: string, livemode: boolean): Promise<void> {
  const [list, cus] = await Promise.all([
    stripe<{ data: StripeCard[] }>("GET", `/v1/customers/${customer}/payment_methods`, { type: "card", limit: 50 }),
    stripe<{ invoice_settings?: { default_payment_method?: string | null } }>("GET", `/v1/customers/${customer}`),
  ]);
  const ids = list.data.map((p) => p.id);
  await db.transaction([
    ...list.data.map((p) => upsert({ ...p, livemode }, customer)),
    q`update stripe_cards set detached_at = now()
      where stripe_customer_id = ${customer} and detached_at is null and not (stripe_payment_method_id = any(${ids}::text[]))`,
    pickDefault(customer, typeof cus.invoice_settings?.default_payment_method === "string" ? cus.invoice_settings.default_payment_method : null),
  ]);
}

/**
 * The card a charge for this email uses in this mode, read fresh from Stripe
 * first; null when they have none.
 */
export async function chargeCard(db: Db, stripe: Stripe, email: string, livemode: boolean): Promise<Card | null> {
  const [cus] = await db.sql<{ stripe_customer_id: string }>`
    select stripe_customer_id from stripe_customers where email = ${email}::citext and livemode = ${livemode}`;
  if (!cus) return null;
  await syncCards(db, stripe, cus.stripe_customer_id, livemode);
  return defaultCard(db, email, livemode);
}

/** A person chose this card for automatic charges: ours, and Stripe's default too, so its hosted page offers it. */
export async function useCard(db: Db, stripe: Stripe, cardId: string): Promise<boolean> {
  const [c] = await db.sql<{ stripe_customer_id: string }>`
    select stripe_customer_id from stripe_cards where stripe_payment_method_id = ${cardId} and detached_at is null`;
  if (!c) return false;
  await stripe("POST", `/v1/customers/${c.stripe_customer_id}`, { invoice_settings: { default_payment_method: cardId } }, { idempotencyKey: `default-${cardId}-${Date.now()}` });
  await db.sql`update stripe_customers set default_card = ${cardId} where stripe_customer_id = ${c.stripe_customer_id}`;
  return true;
}

/** Remove a saved card in Stripe; the mirror and the default follow at once (and again from its event). */
export async function removeCard(db: Db, stripe: Stripe, cardId: string): Promise<boolean> {
  const [c] = await db.sql<{ stripe_customer_id: string; livemode: boolean }>`
    select stripe_customer_id, livemode from stripe_cards where stripe_payment_method_id = ${cardId} and detached_at is null`;
  if (!c) return false;
  await stripe("POST", `/v1/payment_methods/${cardId}/detach`, {}, { idempotencyKey: `detach-${cardId}` });
  await db.transaction([
    q`update stripe_cards set detached_at = now() where stripe_payment_method_id = ${cardId}`,
    pickDefault(c.stripe_customer_id, null),
  ]);
  return true;
}

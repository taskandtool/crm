// Tax rates, for invoices and checkouts alike: a name, a percent in basis
// points (8.25% is 825), and whether prices already include it. A rate never
// changes once made (Stripe's do not either): make a new one and stop
// offering the old one. Each is made in Stripe once per mode, when first used.
//
//   const rates = await taxRates(db, { activeOnly: true });
//   const txr = await stripeTaxRate(db, stripe, rate, livemode);   // "txr_..." for a line's tax_rates
import type { Db } from "../data/db";
import type { Stripe } from "./stripe";

export type TaxRate = { id: string; name: string; percent_bp: number; inclusive: boolean; active: boolean; stripe_tax_rate_id: string | null };

const toRate = (r: Record<string, any>): TaxRate => ({
  id: String(r.id),
  name: r.name,
  percent_bp: Number(r.percent_bp),
  inclusive: Boolean(r.inclusive),
  active: Boolean(r.active),
  stripe_tax_rate_id: r.stripe_tax_rate_id ?? null,
});

export async function taxRates(db: Db, opts: { activeOnly?: boolean } = {}): Promise<TaxRate[]> {
  const rows = await db.sql`
    select id, name, percent_bp, inclusive, active, stripe_tax_rate_id from tax_rates
    where (${opts.activeOnly ?? false}::boolean = false or active) order by active desc, name, id`;
  return rows.map(toRate);
}

/** "8.25" as basis points (825), or null. */
export function percentToBp(input: unknown): number | null {
  const s = typeof input === "string" ? input.trim().replace(/%$/, "").trim() : typeof input === "number" ? String(input) : "";
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const bp = Math.round(Number(s) * 100);
  return bp <= 10000 ? bp : null;
}

/** Stripe's percentage for basis points: 825 is "8.25". */
const percentage = (bp: number) => (bp / 100).toFixed(2).replace(/\.?0+$/, "");

export const percentText = (bp: number): string => `${percentage(bp)}%`;

/** A new rate. Rates never change; deactivate one and make another. */
export async function createTaxRate(
  db: Db,
  f: { name?: unknown; percent?: unknown; inclusive?: unknown },
  by: string,
): Promise<{ ok: true; value: TaxRate } | { ok: false; errors: Record<string, string> }> {
  const errors: Record<string, string> = {};
  const name = typeof f.name === "string" ? f.name.trim() : "";
  if (!name || name.length > 100) errors.name = "Name it in up to 100 characters, like Colorado sales tax.";
  const bp = percentToBp(f.percent);
  if (bp === null) errors.percent = "Enter a percent like 8.25.";
  if (Object.keys(errors).length) return { ok: false, errors };
  const inclusive = f.inclusive === true || f.inclusive === "on" || f.inclusive === "1" || f.inclusive === "true";
  const [r] = await db.sql`
    insert into tax_rates (name, percent_bp, inclusive, updated_by) values (${name}, ${bp}, ${inclusive}, ${by})
    returning id, name, percent_bp, inclusive, active, stripe_tax_rate_id`;
  return { ok: true, value: toRate(r) };
}

export async function setTaxRateActive(db: Db, id: string, active: boolean, by: string): Promise<void> {
  await db.sql`update tax_rates set active = ${active}, updated_by = ${by} where id = ${id}::bigint`;
}

/** The rate's id in Stripe for this mode, made there the first time it is used. */
export async function stripeTaxRate(db: Db, stripe: Stripe, rate: TaxRate, livemode: boolean): Promise<string> {
  const [row] = await db.sql<{ stripe_tax_rate_id: string | null; livemode: boolean | null; stripe_key: string }>`
    select stripe_tax_rate_id, livemode, stripe_key from tax_rates where id = ${rate.id}::bigint`;
  if (!row) throw new Error(`tax rate ${rate.id} is not in tax_rates`);
  if (row.stripe_tax_rate_id && row.livemode === livemode) return row.stripe_tax_rate_id;
  const made = await stripe<{ id: string }>("POST", "/v1/tax_rates", {
    display_name: rate.name.slice(0, 50), percentage: percentage(rate.percent_bp), inclusive: rate.inclusive, metadata: { tax_rate_id: rate.id },
  }, { idempotencyKey: `taxrate-${row.stripe_key}-${livemode ? "live" : "test"}` });
  await db.sql`update tax_rates set stripe_tax_rate_id = ${made.id}, livemode = ${livemode} where id = ${rate.id}::bigint`;
  return made.id;
}

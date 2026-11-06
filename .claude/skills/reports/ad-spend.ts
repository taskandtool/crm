// What was spent on ads, as a daily job saves it (reports/schema.sql).
//
//   await saveAdSpend(db, [{ day: "2026-11-05", source: "facebook", campaign: "Spring Roof", content: "Roof | 4:5", spend_cents: 4210, currency: "usd" }]);
//
// Tags go through the same `token` a form's UTM does, so "Spring Roof" here
// matches `utm_campaign=Spring+Roof` on the lead. Rows of one batch with the same day and name are
// added together (two ad sets running one ad name). Saving a day and ad again replaces it.
import type { Db } from "../data/db";
import { token } from "../forms/origin";

export type AdSpend = { day: string; source: string; campaign?: string | null; content?: string | null; spend_cents: number; currency: string; clicks?: number | null; impressions?: number | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** What is wrong with a row, in a sentence, or null. */
export function adSpendProblem(r: AdSpend): string | null {
  if (!r || typeof r !== "object") return "should be an object";
  const at = DAY.test(r.day ?? "") ? new Date(`${r.day}T00:00:00Z`) : null;
  if (!at || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== r.day) return `day ${JSON.stringify(r.day)} should be a date, YYYY-MM-DD`;
  if (!token(r.source)) return `source ${JSON.stringify(r.source)} is not a tag: facebook, google`;
  for (const k of ["campaign", "content"] as const) {
    if (r[k] && !token(r[k])) return `${k} ${JSON.stringify(r[k])} can't be a tag: no @, < or > in it`;
  }
  if (!Number.isSafeInteger(r.spend_cents) || r.spend_cents < 0) return `spend_cents ${JSON.stringify(r.spend_cents)} should be whole cents`;
  if (!/^[a-z]{3}$/i.test(r.currency ?? "")) return `currency ${JSON.stringify(r.currency)} should be a three-letter code`;
  for (const k of ["clicks", "impressions"] as const) {
    const v = r[k];
    if (v !== undefined && v !== null && (!Number.isSafeInteger(v) || v < 0)) return `${k} ${JSON.stringify(v)} should be a whole number`;
  }
  return null;
}

/** Saves the rows, all or none. Refuses a whole batch on one bad row, naming it. */
export async function saveAdSpend(db: Db, rows: AdSpend[]): Promise<{ ok: true; saved: number } | { ok: false; why: string }> {
  for (const [i, r] of rows.entries()) {
    const why = adSpendProblem(r);
    if (why) return { ok: false, why: `row ${i + 1}: ${why}` };
  }
  const merged = new Map<string, { day: string; source: string; campaign: string; content: string; spend: number; currency: string; clicks: number | null; impressions: number | null }>();
  for (const r of rows) {
    const key = { day: r.day, source: token(r.source)!, campaign: token(r.campaign) ?? "", content: token(r.content) ?? "" };
    const id = JSON.stringify(key);
    const had = merged.get(id);
    const plus = (a: number | null | undefined, b: number | null | undefined) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
    merged.set(id, { ...key, spend: (had?.spend ?? 0) + r.spend_cents, currency: r.currency.toLowerCase(), clicks: plus(had?.clicks, r.clicks), impressions: plus(had?.impressions, r.impressions) });
  }
  await db.transaction([...merged.values()].map((r) => ({
    text: `insert into ad_spend (day, source, campaign, content, spend_cents, currency, clicks, impressions)
           values ($1::date, $2, $3, $4, $5, $6, $7, $8)
           on conflict (day, source, campaign, content) do update set
             spend_cents = excluded.spend_cents, currency = excluded.currency, clicks = excluded.clicks, impressions = excluded.impressions, updated_at = now()`,
    values: [r.day, r.source, r.campaign, r.content, r.spend, r.currency, r.clicks, r.impressions],
  })));
  return { ok: true, saved: rows.length };
}

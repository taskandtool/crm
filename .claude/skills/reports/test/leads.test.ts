import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applySchema } from "../../data/migrate";
import { LEAD_OUTCOMES, setLeadOutcome } from "../../customers/customer";
import { adSpendProblem, saveAdSpend } from "../ad-spend";
import { breakdown, bucketsOf, costPerLead, LeadBreakdown, LeadKpis, loadLeadReport, type LeadReport } from "../leads";
import { scratch, why, type Scratch } from "../../data/test/scratch";

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
const html = async (node: unknown) => String(await (node as { toString(): string | Promise<string> }).toString());

test("cost per lead is total over total, and unknown with no cost rather than free", () => {
  assert.equal(costPerLead({ spend_cents: 1000, ad_leads: 4 }), 250);
  assert.equal(costPerLead({ spend_cents: 0, ad_leads: 4 }), null);
  assert.equal(costPerLead({ spend_cents: 1000, ad_leads: 0 }), null);
});

test("every day, week or month of the period is a bucket, quiet ones too", () => {
  assert.deepEqual(bucketsOf({ from: "2026-11-01", to: "2026-11-03" }, "day"), ["2026-11-01", "2026-11-02", "2026-11-03"]);
  assert.deepEqual(bucketsOf({ from: "2026-11-01", to: "2026-11-10" }, "week"), ["2026-10-26", "2026-11-02", "2026-11-09"]);
  assert.deepEqual(bucketsOf({ from: "2026-10-30", to: "2026-11-02" }, "month"), ["2026-10-01", "2026-11-01"]);
});

test("a bad row of ad spend names what is wrong", () => {
  const ok = { day: "2026-11-05", source: "facebook", spend_cents: 100, currency: "usd" };
  assert.equal(adSpendProblem(ok), null);
  assert.match(adSpendProblem({ ...ok, day: "Nov 5" })!, /YYYY-MM-DD/);
  assert.match(adSpendProblem({ ...ok, spend_cents: 1.5 })!, /whole cents/);
  assert.match(adSpendProblem({ ...ok, source: "" })!, /not a tag/);
});

const period = { from: "2026-11-01", to: "2026-11-07" };

async function withReport(fn: (s: Scratch, load: () => Promise<LeadReport>) => Promise<void>) {
  const s = await scratch();
  if (!s) return;
  try {
    for (const f of ["data/schema.sql", "forms/schema.sql", "booking/schema.sql", "customers/schema.sql", "reports/schema.sql"]) await applySchema(s.db, read(f));
    await fn(s, () => loadLeadReport(s.db, { period, zone: "America/New_York", currency: "usd" }));
  } finally {
    await s.drop();
  }
}

async function lead(s: Scratch, email: string, utm: Record<string, string> | null, at = "2026-11-03T15:00:00Z") {
  const [c] = await s.db.sql<{ id: string }>`insert into customers (name, email, stage) values (${email}, ${email}, 'lead') returning id::text as id`;
  const [sub] = await s.db.sql<{ id: string }>`insert into submissions (form_key, email, source, data, completed_at, created_at) values ('quote', ${email}, 'website', ${JSON.stringify(utm ? { _utm: utm } : {})}::jsonb, ${at}::timestamptz, ${at}::timestamptz) returning id::text as id`;
  const [l] = await s.db.sql<{ id: string }>`insert into leads (customer_id, source, submission_id, title, created_at) values (${c.id}::bigint, 'form', ${sub.id}::bigint, 'Quote', ${at}::timestamptz) returning id::text as id`;
  return { id: l.id, submission: sub.id };
}

test("the report at the start: all zero, nothing broken", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withReport(async (_s, load) => {
    const r = await load();
    assert.equal(r.total.leads, 0);
    assert.equal(r.total.spend_cents, 0);
    const kpis = await html(LeadKpis({ report: r }));
    assert.match(kpis, /Cost per ad lead/);
    assert.match(await html(LeadBreakdown({ report: r, by: "source" })), /No leads in this period/);
  }));

test("spend meets the leads its ad brought, by the same tags, and shows even with no lead", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withReport(async (s, load) => {
    await lead(s, "a@x.example", { source: "facebook", campaign: "spring-roof", content: "roof-|-4:5" });
    await lead(s, "b@x.example", { source: "facebook", campaign: "spring-roof", content: "roof-|-4:5" });
    await lead(s, "c@x.example", null);
    assert.deepEqual(await saveAdSpend(s.db, [
      { day: "2026-11-03", source: "Facebook", campaign: "Spring Roof", content: "Roof | 4:5", spend_cents: 5000, currency: "USD", clicks: 90 },
      { day: "2026-11-03", source: "Facebook", campaign: "Spring Roof", content: "Quiet ad", spend_cents: 700, currency: "usd" },
      { day: "2026-11-03", source: "Facebook", campaign: "Euros", spend_cents: 999, currency: "eur" },
    ]), { ok: true, saved: 3 });
    // Saved again, a day and ad is replaced, not added.
    await saveAdSpend(s.db, [{ day: "2026-11-03", source: "facebook", campaign: "spring roof", content: "roof | 4:5", spend_cents: 6000, currency: "usd", clicks: 95 }]);
    const r = await load();
    assert.equal(r.total.leads, 3);
    assert.equal(r.total.spend_cents, 6700);
    assert.deepEqual(r.otherCurrencies, ["eur"]);
    const ads = breakdown(r, "content");
    assert.deepEqual(ads.map((a) => [a.name, a.leads, a.spend_cents]), [["roof-|-4:5", 2, 6000], ["", 1, 0], ["quiet-ad", 0, 700]]);
    assert.equal(costPerLead(ads[0]), 3000);
    assert.match(await html(LeadBreakdown({ report: r, by: "content" })), /Roof \| 4:5/);
  }));

test("free leads don't make ads look cheap, fb is facebook, and keywords show without cost", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withReport(async (s, load) => {
    await lead(s, "a@x.example", { source: "fb", term: "roof-repair" });
    await lead(s, "b@x.example", { source: "facebook" });
    await lead(s, "c@x.example", { source: "nextdoor.com" });
    await lead(s, "d@x.example", null);
    await saveAdSpend(s.db, [{ day: "2026-11-03", source: "facebook", spend_cents: 4000, currency: "usd" }]);
    const r = await load();
    assert.equal(r.total.leads, 4);
    assert.equal(costPerLead(r.total), 2000, "$40 over the two from Facebook, not all four");
    assert.deepEqual(breakdown(r, "source").map((x) => [x.name, x.leads]), [["facebook", 2], ["direct", 1], ["nextdoor.com", 1]]);
    const words = await html(LeadBreakdown({ report: r, by: "term" }));
    assert.match(words, /Roof repair/);
    assert.doesNotMatch(words, /Ad cost/);
    // A cost with nothing ads could have brought isn't a cost per lead.
    await s.db.sql`delete from ad_spend`;
    await saveAdSpend(s.db, [{ day: "2026-11-03", source: "google", spend_cents: 9000, currency: "usd" }]);
    await s.db.sql`delete from leads where id in (select l.id from leads l join submissions s on s.id = l.submission_id where s.data->'_utm'->>'source' = 'google')`;
    assert.equal(costPerLead((await load()).total), null);
  }));

test("how far a lead got counts from its outcome or its booking; spam and other periods do not count", { skip: !process.env.TEST_DATABASE_URL && why }, () =>
  withReport(async (s, load) => {
    const sold = await lead(s, "sold@x.example", { source: "facebook" });
    const noShow = await lead(s, "noshow@x.example", { source: "facebook" });
    const booked = await lead(s, "booked@x.example", { source: "facebook" });
    const held = await lead(s, "held@x.example", { source: "facebook" });
    const spam = await lead(s, "spam@x.example", { source: "facebook" });
    await s.db.sql`update submissions set status = 'spam' where id = ${spam.submission}::bigint`;
    await lead(s, "old@x.example", { source: "facebook" }, "2026-10-01T15:00:00Z");
    assert.ok(LEAD_OUTCOMES.includes("no_show"));
    await setLeadOutcome(s.db, sold.id, { outcome: "sold", soldCents: 120000, externalId: "i360-9", externalStatus: "Sold" }, "job");
    await setLeadOutcome(s.db, noShow.id, { outcome: "no_show" }, "job");
    const book = async (sid: string, hold: string | null) => s.db.sql`insert into bookings (name, email, starts_at, ends_at, location_kind, status, source, submission_id, hold_until) values ('B', 'b@x.example', '2026-11-10T15:00:00Z', '2026-11-10T16:00:00Z', 'phone', 'confirmed', 'test', ${sid}::bigint, ${hold}::timestamptz)`;
    await book(booked.submission, null);
    await book(held.submission, "2026-11-10T15:00:00Z");
    const r = await load();
    assert.equal(r.total.leads, 4, "not the spam, not last month");
    assert.equal(r.total.appointments, 3, "sold, no-show and booked; not one still held for payment");
    assert.equal(r.total.no_shows, 1);
    assert.equal(r.total.sold, 1);
    assert.equal(r.total.sold_cents, 120000);
    assert.equal(r.earlier.leads, 0);
    // A status alone leaves what was said before.
    await setLeadOutcome(s.db, sold.id, { externalStatus: "Installed" }, "job");
    const [row] = await s.db.sql<{ outcome: string; sold_cents: string; external_id: string; external_status: string; synced: boolean }>`select outcome, sold_cents::text, external_id, external_status, external_synced_at is not null as synced from leads where id = ${sold.id}::bigint`;
    assert.deepEqual(row, { outcome: "sold", sold_cents: "120000", external_id: "i360-9", external_status: "Installed", synced: true });
  }));

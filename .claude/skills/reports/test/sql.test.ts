import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { q } from "../../data/db";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import { compareQuery, days, lastFull, previousPeriod, ratioOfSums, run, seriesQuery, weightedMean } from "../sql";

const NY = "America/New_York";

test("the previous period has the same length and ends the day before", () => {
  for (const p of [
    { from: "2026-09-01", to: "2026-09-28" },
    { from: "2026-03-02", to: "2026-03-08" },
    { from: "2026-01-01", to: "2026-01-01" },
  ]) {
    const prev = previousPeriod(p);
    assert.equal(days(prev), days(p));
    assert.equal(prev.to < p.from, true);
    assert.equal(Date.parse(p.from) - Date.parse(prev.to), 86_400_000);
  }
  // with a month grain, whole months compare with whole months, so month buckets line up
  assert.deepEqual(previousPeriod({ from: "2026-03-01", to: "2026-03-31" }, "month"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(previousPeriod({ from: "2026-01-01", to: "2026-03-31" }, "month"), { from: "2025-10-01", to: "2025-12-31" });
  // 28 days that happen to be February (lastFull("day", 28) on 1 March) compare with 28 days, not January's 31
  assert.deepEqual(previousPeriod({ from: "2026-02-01", to: "2026-02-28" }), { from: "2026-01-04", to: "2026-01-31" });
  assert.deepEqual(previousPeriod({ from: "2026-02-01", to: "2026-02-28" }, "week"), { from: "2026-01-04", to: "2026-01-31" });
  assert.deepEqual(previousPeriod({ from: "2026-02-01", to: "2026-02-28" }, "month"), { from: "2026-01-01", to: "2026-01-31" });
});

test("a date that does not exist is refused, not rolled over", () => {
  assert.throws(() => previousPeriod({ from: "2026-02-30", to: "2026-03-05" }), /not a date: 2026-02-30/);
  assert.throws(() => days({ from: "2026-04-01", to: "2026-04-31" }), /not a date/);
});

test("lastFull takes whole days, Monday weeks and months before today in the zone", () => {
  // 03:00 UTC on Tuesday 3 Nov is still Monday 2 Nov in New York
  const now = new Date("2026-11-03T03:00:00Z");
  assert.deepEqual(lastFull("day", 7, NY, { now }), { from: "2026-10-26", to: "2026-11-01" });
  assert.deepEqual(lastFull("week", 2, NY, { now }), { from: "2026-10-19", to: "2026-11-01" });
  assert.deepEqual(lastFull("month", 1, NY, { now }), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(lastFull("day", 28, NY, { now, lag: 3 }).to, "2026-10-29");
});

test("a ratio comes from the totals, not from averaging each row's ratio", () => {
  const rows = [
    { clicks: 1, impressions: 1, position: 1 },
    { clicks: 0, impressions: 99, position: 30 },
  ];
  const naive = rows.reduce((s, r) => s + r.clicks / r.impressions, 0) / rows.length;
  assert.equal(naive, 0.5);
  assert.equal(ratioOfSums(rows, "clicks", "impressions"), 0.01);
  assert.equal(weightedMean(rows, "position", "impressions"), (1 * 1 + 30 * 99) / 100);
  assert.equal(ratioOfSums([{ a: 1, b: 0 }], "a", "b"), null);
});

test("an identifier can only come from the allowlist and values are parameters", () => {
  const qy = seriesQuery("leads", { from: "2026-09-01", to: "2026-09-07" }, "day", NY);
  assert.match(qy.text, /from submissions/);
  assert.deepEqual(qy.values, ["2026-09-01", "2026-09-07", "day", NY]);
  // @ts-expect-error a source that is not in SOURCES does not compile
  assert.throws(() => seriesQuery("users; drop table x", { from: "2026-09-01", to: "2026-09-07" }, "day", NY));
  assert.throws(() => seriesQuery("leads", { from: "2026-09-01", to: "2026-09-07" }, "day", "Mars/Olympus"), RangeError);
  assert.throws(() => seriesQuery("leads", { from: "2026-09-08", to: "2026-09-07" }, "day", NY));
});

let t: Scratch | null = null;
before(async () => {
  t = await scratch();
  if (!t) return;
  await t.db.sql`create table submissions (id bigserial primary key, form_key text, email citext, source text, status text not null default 'new', created_at timestamptz not null)`;
});
after(async () => t?.drop());

async function leads(...instants: string[]) {
  await t!.db.sql`truncate submissions`;
  for (const at of instants) await t!.db.sql`insert into submissions (form_key, email, source, created_at) values ('contact', 'a@example.com', 'website', ${at})`;
}

test("a day bucket on the fall-back day holds its 25 hours", { skip: !process.env.TEST_DATABASE_URL && why }, async () => {
  // one lead every hour from New York midnight on 1 Nov 2026 (04:00 UTC, still EDT) for 27 hours
  const start = Date.parse("2026-11-01T04:00:00Z");
  await leads(...Array.from({ length: 27 }, (_, h) => new Date(start + h * 3_600_000).toISOString()));
  const rows = await run(t!.db, seriesQuery("leads", { from: "2026-11-01", to: "2026-11-02" }, "day", NY));
  assert.deepEqual(rows, [
    { bucket: "2026-11-01", value: 25 },
    { bucket: "2026-11-02", value: 2 },
  ]);
});

test("a week bucket across the change is still Monday to Sunday in the zone", { skip: !process.env.TEST_DATABASE_URL && why }, async () => {
  await leads(
    "2026-10-26T04:00:00Z", // Mon 26 Oct 00:00 EDT
    "2026-11-02T04:59:00Z", // Sun 1 Nov 23:59 EST
    "2026-11-02T05:00:00Z", // Mon 2 Nov 00:00 EST
    "2026-10-26T03:59:00Z", // Sun 25 Oct 23:59 EDT, the week before
  );
  const rows = await run(t!.db, seriesQuery("leads", { from: "2026-10-19", to: "2026-11-08" }, "week", NY));
  assert.deepEqual(rows, [
    { bucket: "2026-10-19", value: 1 },
    { bucket: "2026-10-26", value: 2 },
    { bucket: "2026-11-02", value: 1 },
  ]);
});

test("quiet buckets are zero, spam is left out, and the session's zone changes nothing", { skip: !process.env.TEST_DATABASE_URL && why }, async () => {
  await leads("2026-09-01T15:00:00Z", "2026-09-03T15:00:00Z");
  await t!.db.sql`insert into submissions (form_key, email, source, status, created_at) values ('contact', 'x@example.com', 'website', 'spam', '2026-09-02T15:00:00Z')`;
  const query = seriesQuery("leads", { from: "2026-09-01", to: "2026-09-05" }, "day", NY);
  const [, rows] = await t!.db.transaction([q`set local timezone = 'Pacific/Auckland'`, query]);
  assert.deepEqual(
    rows.map((r) => r.value),
    [1, 0, 1, 0, 0],
  );
});

test("totals for a period and the one before come from one pass", { skip: !process.env.TEST_DATABASE_URL && why }, async () => {
  // 1 Sep 00:30 New York is 31 Aug in UTC: it belongs to September here
  await leads("2026-09-01T04:30:00Z", "2026-09-07T12:00:00Z", "2026-08-31T12:00:00Z", "2026-08-20T12:00:00Z", "2026-09-08T12:00:00Z");
  const [row] = await run(t!.db, compareQuery("leads", { from: "2026-09-01", to: "2026-09-07" }, NY));
  assert.deepEqual(row, { current: 2, previous: 1 });
  assert.throws(() => compareQuery("leads", { from: "2026-09-01", to: "2026-09-07" }, NY, { from: "2026-08-01", to: "2026-08-07" }));
});

test("a money source is charted one currency at a time, live money only", { skip: !process.env.TEST_DATABASE_URL && why }, async () => {
  await t!.db.sql`create table if not exists invoices (id bigserial primary key, status text, livemode boolean, currency text, total_cents bigint, paid_at timestamptz)`;
  await t!.db.sql`insert into invoices (status, livemode, currency, total_cents, paid_at) values
    ('paid', true, 'usd', 10000, '2026-08-15T12:00:00Z'), ('paid', true, 'usd', 2500, '2026-09-02T12:00:00Z'),
    ('paid', true, 'eur', 7000, '2026-09-03T12:00:00Z'), ('paid', false, 'usd', 99900, '2026-09-04T12:00:00Z'),
    ('open', true, 'usd', 5000, null)`;
  const p = { from: "2026-08-01", to: "2026-09-30" };
  assert.deepEqual(await run(t!.db, seriesQuery("invoices_paid", p, "month", NY, "usd")), [{ bucket: "2026-08-01", value: 10000 }, { bucket: "2026-09-01", value: 2500 }]);
  assert.deepEqual(await run(t!.db, seriesQuery("invoices_paid", p, "month", NY, "EUR")), [{ bucket: "2026-08-01", value: 0 }, { bucket: "2026-09-01", value: 7000 }]);
  const [row] = await run(t!.db, compareQuery("invoices_paid", { from: "2026-09-01", to: "2026-09-30" }, NY, undefined, "usd"));
  assert.deepEqual(row, { current: 2500, previous: 10000 });
  assert.throws(() => seriesQuery("invoices_paid", p, "month", NY), /one currency at a time/);
  assert.throws(() => seriesQuery("leads", p, "month", NY, "usd"), /not money/);
});

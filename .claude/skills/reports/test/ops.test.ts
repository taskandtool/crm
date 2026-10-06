import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { scratch, why, type Scratch } from "../../data/test/scratch";
import { loadOps, OpsReport } from "../ops";
import { run, revenueQuery } from "../sql";

const NY = "America/New_York";
const period = { from: "2026-09-01", to: "2026-09-30" }; // previous: 2 Aug to 31 Aug

let t: Scratch | null = null;
const skip = !process.env.TEST_DATABASE_URL && why;

before(async () => {
  t = await scratch();
  if (!t) return;
  await t.db.sql`create table submissions (id bigserial primary key, form_key text, email citext, source text, status text not null default 'new', data jsonb not null default '{}', created_at timestamptz not null)`;
  await t.db.sql`create table forms (id bigserial primary key, key text not null unique, title text not null)`;
  await t.db.sql`insert into forms (key, title) values ('contact', 'Contact')`;
});
after(async () => t?.drop());

test("a project with only forms gets leads and a one-step funnel, and says what is missing", { skip }, async () => {
  const db = t!.db;
  await db.sql`insert into submissions (form_key, email, source, status, data, created_at) values
    ('contact', 'Ann@Example.com', 'website', 'new', '{"_utm": {"source": "google", "medium": "cpc"}, "_referrer": "google.com"}', '2026-09-02T15:00:00Z'),
    ('contact', 'bob@example.com', 'website', 'spam', '{"_utm": {"source": "spamhub"}}', '2026-09-03T15:00:00Z'),
    ('quote', 'cat@example.com', 'crm', 'new', '{"_referrer": "news.example"}', '2026-09-20T15:00:00Z'),
    ('contact', 'ann@example.com', 'website', 'new', '{"message": "again"}', '2026-09-21T15:00:00Z'),
    ('contact', 'old@example.com', 'website', 'new', '{}', '2026-08-20T15:00:00Z')`;
  const data = await loadOps(db, { period, grain: "week", zone: NY });
  assert.deepEqual(data.tables, { submissions: true, forms: true, bookings: false, payments: false, paymentTotals: false });
  assert.equal(data.leads?.current, 3);
  assert.equal(data.leads?.previous, 1);
  // Where they came from: the UTM source first, else the referrer's host, else direct. Never the app's slug.
  assert.deepEqual(data.leads?.byOrigin, [{ origin: "direct", leads: 1 }, { origin: "google", leads: 1 }, { origin: "news.example", leads: 1 }]);
  // By form: the form's title where forms has it, else its key.
  assert.deepEqual(data.leads?.byForm, [{ form: "Contact", leads: 2 }, { form: "quote", leads: 1 }]);
  assert.equal(data.bookings, null);
  assert.equal(data.revenue, null);
  assert.deepEqual(data.funnel, [{ step: "lead", people: 2 }]); // Ann twice is one person
  const out = String(await OpsReport({ data }).toString());
  assert.match(out, /Leads by where they came from/);
  assert.match(out, /Direct or unknown/);
  assert.match(out, /Leads by form/);
  assert.doesNotMatch(out, /Leads by source/);
  assert.match(out, /This project has no bookings yet/);
  assert.match(out, /This project has no payments yet/);
});

test("the funnel matches people by email whatever its case, and only narrows", { skip }, async () => {
  const db = t!.db;
  await db.sql`create table bookings (id bigserial primary key, resource_id bigint, email citext not null, status text not null, starts_at timestamptz not null, name text, created_at timestamptz not null)`;
  await db.sql`create table payments (id bigserial primary key, email citext, amount_cents bigint not null, refunded_cents bigint not null default 0, currency text not null, status text not null, kind text, livemode boolean, paid_at timestamptz, created_at timestamptz not null default now())`;
  await db.sql`insert into bookings (resource_id, email, status, starts_at, name, created_at) values
    (1, 'ANN@example.COM', 'completed', '2026-09-10T14:00:00Z', 'Ann', '2026-09-03T10:00:00Z'),
    (1, 'cat@example.com', 'no_show', '2026-09-25T14:00:00Z', 'Cat', '2026-09-21T10:00:00Z'),
    (1, 'stranger@example.com', 'completed', '2026-09-12T14:00:00Z', null, '2026-09-04T10:00:00Z')`;
  await db.sql`insert into payments (email, amount_cents, currency, status, livemode, paid_at) values
    ('ann@EXAMPLE.com', 5000, 'usd', 'paid', true, '2026-09-10T16:00:00Z'),
    ('stranger@example.com', 9000, 'usd', 'paid', true, '2026-09-12T16:00:00Z')`;
  const data = await loadOps(db, { period, grain: "week", zone: NY });
  assert.deepEqual(
    data.funnel?.map((s) => [s.step, s.people]),
    [
      ["lead", 2],
      ["booked", 2],
      ["showed", 1],
      ["paid", 1],
    ],
  );
  assert.equal(data.bookings?.current, 3);
  assert.equal(data.bookings?.recent[0].name, "Cat");
  assert.equal(data.bookings?.recent[0].starts_at, "2026-09-25T14:00:00Z");
  const out = String(await OpsReport({ data }).toString());
  assert.match(out, /Booked 2 \(100% of Leads\), Showed 1 \(50% of Booked\), Paid 1 \(100% of Showed\)/);
  assert.match(out, /Sep 25, 2026, 10:00/); // 14:00 UTC shown in New York
});

test("revenue is per currency, net of refunds, and never summed across currencies", { skip }, async () => {
  const db = t!.db;
  await db.sql`truncate payments`;
  await db.sql`insert into payments (email, amount_cents, refunded_cents, currency, status, livemode, paid_at) values
    ('a@example.com', 10000, 0, 'usd', 'paid', true, '2026-09-05T12:00:00Z'),
    ('b@example.com', 4000, 1500, 'usd', 'partially_refunded', true, '2026-09-06T12:00:00Z'),
    ('c@example.com', 2000, 2000, 'usd', 'refunded', true, '2026-09-07T12:00:00Z'),
    ('d@example.com', 3000, 0, 'eur', 'paid', true, '2026-09-08T12:00:00Z'),
    ('e@example.com', 500000, 0, 'jpy', 'paid', null, '2026-09-08T12:00:00Z'),
    ('f@example.com', 7000, 0, 'eur', 'paid', true, '2026-08-15T12:00:00Z'),
    ('g@example.com', 99900, 0, 'usd', 'paid', false, '2026-09-09T12:00:00Z'),
    ('h@example.com', 1000, 0, 'usd', 'pending', true, null),
    ('i@example.com', 1000, 0, 'usd', 'failed', true, '2026-09-09T12:00:00Z')`;
  const rows = await run(db, revenueQuery(period, NY));
  assert.deepEqual(rows, [
    { currency: "JPY", gross: 500000, refunds: 0, net: 500000, previous_net: 0 },
    { currency: "USD", gross: 16000, refunds: 3500, net: 12500, previous_net: 0 },
    { currency: "EUR", gross: 3000, refunds: 0, net: 3000, previous_net: 7000 },
  ]);
  const out = String(await OpsReport({ data: await loadOps(db, { period, grain: "week", zone: NY }) }).toString());
  assert.match(out, /Revenue, USD \$125\.00/);
  assert.match(out, /Revenue, JPY ¥500,000/);
  assert.match(out, /Revenue, EUR €30\.00, down 57\.1%/);
});

test("a payment whose refund arrived before its payment event still counts, placed by when it was made", { skip }, async () => {
  // an early charge.refunded moves pending straight to (partially_)refunded, and paid_at is empty until the payment event
  const db = t!.db;
  await db.sql`truncate payments`;
  await db.sql`insert into payments (email, amount_cents, refunded_cents, currency, status, livemode, paid_at, created_at) values
    ('ann@example.com', 6000, 2000, 'usd', 'partially_refunded', true, null, '2026-09-10T12:00:00Z'),
    ('x@example.com', 3000, 3000, 'usd', 'refunded', true, null, '2026-09-11T12:00:00Z'),
    ('y@example.com', 9000, 0, 'usd', 'pending', true, null, '2026-09-11T12:00:00Z')`;
  const rows = await run(db, revenueQuery(period, NY));
  assert.deepEqual(rows, [{ currency: "USD", gross: 9000, refunds: 5000, net: 4000, previous_net: 0 }]);
  const data = await loadOps(db, { period, grain: "week", zone: NY });
  assert.deepEqual(data.funnel?.at(-1), { step: "paid", people: 1 });
});

test("the previous period follows the grain, and the sentence names its real length", { skip }, async () => {
  const db = t!.db;
  // a week grain over September compares with the 30 days before, not with August's 31
  assert.deepEqual((await loadOps(db, { period, grain: "week", zone: NY })).previous, { from: "2026-08-02", to: "2026-08-31" });
  const monthly = await loadOps(db, { period, grain: "month", zone: NY });
  assert.deepEqual(monthly.previous, { from: "2026-08-01", to: "2026-08-31" });
  const out = String(await OpsReport({ data: monthly }).toString());
  assert.match(out, /on the previous 31 days/);
  assert.doesNotMatch(out, /on the previous 30 days/);
});

// Deals, follow-ups, merging and the morning email, against a real Postgres
// when TEST_DATABASE_URL is set (each run in its own schema, dropped after);
// the pure parts run everywhere.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Db } from "../src/data/db";
import { applySchema } from "../src/data/migrate";
import { setup } from "../src/db/setup";
import { createCustomer, findMatch, getCustomer } from "../src/crm/customers";
import { board, createDeal, dealTotals, getDeal, setDealStage, winFromQuotes, type DealInput } from "../src/crm/deals";
import { digestMessage, sendDigests } from "../src/crm/digest";
import {
  addDays, addFollowUp, doneFollowUp, dueOf, followUpCounts, listFollowUps, moveFollowUp, nextFollowUps, nothingPlanned, readDay, readTime, relativeDay,
} from "../src/crm/follow-ups";
import { everythingFrom } from "../src/crm/history";
import { mergeCustomers, mergePreview, possibleDuplicates } from "../src/crm/merge";
import type { StageConfig } from "../src/config-schema";
import { dueDayText } from "../src/views/ui";
import { scratch, type Scratch } from "./scratch";

const ME = "ann@team.example";
const STATUSES: StageConfig[] = [
  { key: "lead", label: "Lead", kind: "open" },
  { key: "customer", label: "Customer", kind: "won" },
  { key: "not-a-fit", label: "Not a fit", kind: "lost" },
];
const DEAL_STAGES: StageConfig[] = [
  { key: "new", label: "New", kind: "open" },
  { key: "quoted", label: "Quote sent", kind: "open" },
  { key: "won", label: "Won", kind: "won" },
  { key: "lost", label: "Lost", kind: "lost" },
];
const deal = (title: string, value: number | null = null): DealInput => ({ title, value_cents: value, currency: "USD", owner: ME, expected_close: null, notes: null });

let s: Scratch | null = null;
let skip: string | false = false;
let db: Db;

before(async () => {
  const r = await scratch("sales");
  if (typeof r === "string") skip = r;
  else {
    s = r;
    db = r.db;
    await setup(db, { statuses: STATUSES, dealStages: DEAL_STAGES }, { booking: false, invoices: true, forms: true });
    await applySchema(db, readFileSync("test/fixtures/other-apps.sql", "utf8"));
  }
});
after(async () => {
  await s?.drop();
});

test("a day said the way the owner says it", () => {
  const thu = "2026-10-08";
  assert.equal(relativeDay("today", thu), thu);
  assert.equal(relativeDay("Tomorrow", thu), "2026-10-09");
  assert.equal(relativeDay("friday", thu), "2026-10-09");
  assert.equal(relativeDay("next thursday", thu), "2026-10-15", "a weekday is the coming one, never today");
  assert.equal(relativeDay("in 3 days", thu), "2026-10-11");
  assert.equal(relativeDay("in 2 weeks", thu), "2026-10-22");
  assert.equal(relativeDay("2026-02-30", thu), null);
  assert.equal(relativeDay("someday", thu), null);
  assert.equal(readDay("2026-12-01"), "2026-12-01");
  assert.equal(readTime("9:30"), "09:30");
  assert.equal(readTime("24:00"), null);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(dueOf({ due_on: "2026-10-07" }, thu), "overdue");
  assert.equal(dueOf({ due_on: thu }, thu), "today");
  assert.equal(dueOf(undefined, thu), "none");
  assert.equal(dueDayText(thu, thu, "14:30"), "Today 2:30 PM");
  assert.equal(dueDayText("2026-10-09", thu), "Tomorrow");
  assert.equal(dueDayText("2027-01-04", thu), "Mon, Jan 4, 2027");
});

test("the morning email: overdue first, then today, then the leads", () => {
  const m = digestMessage("ann@team.example", [
    { owner: ME, kind: "call", title: "Call back Pat", due_on: "2026-10-06", due_time: null, customer_name: "Pat Doe", customer_phone: "555 0100" },
    { owner: ME, kind: "email", title: "Send the quote", due_on: "2026-10-08", due_time: "14:00", customer_name: "Bo Ray", customer_phone: null },
  ], "2026-10-08", 3);
  assert.equal(m.subject, "1 overdue and 1 due today");
  assert.match(m.text, /Overdue\n- Call: Call back Pat \(Pat Doe, 555 0100\), due 2026-10-06\n\nToday\n- Email: Send the quote \(Bo Ray\), 14:00\n\n3 new leads came in since yesterday\./);
  assert.doesNotMatch(m.text, /—/);
});

test("deals: opened, moved, closed; winning makes an open status a customer; the board's totals", async (t) => {
  if (skip) return t.skip(skip);
  const { customer } = await createCustomer(db, { name: "Dee Al", email: "dee@example.com", stage: "lead" }, ME);
  assert.equal(await createDeal(db, customer.id, deal("Nowhere"), "no-such-stage", ME), null);
  const d = (await createDeal(db, customer.id, deal("Roof", 900000), "new", ME))!;
  assert.equal(d.closed_at, null);
  assert.equal((await setDealStage(db, d.id, "nope", ME)), null);
  const lost = (await setDealStage(db, d.id, "lost", ME, "Price"))!;
  assert.ok(lost.closed_at);
  assert.equal(lost.lost_reason, "Price");
  assert.equal((await getCustomer(db, customer.id))!.stage, "lead", "a lost deal leaves them a lead");
  const back = (await setDealStage(db, d.id, "quoted", ME))!;
  assert.deepEqual([back.closed_at, back.lost_reason], [null, null], "open again");
  await setDealStage(db, d.id, "won", ME);
  assert.equal((await getCustomer(db, customer.id))!.stage, "customer");
  // A customer marked not a fit is not turned into a customer by a won deal.
  const { customer: nf } = await createCustomer(db, { name: "No Fit", email: "nofit@example.com", stage: "not-a-fit" }, ME);
  await createDeal(db, nf.id, deal("Odd job"), "won", ME);
  assert.equal((await getCustomer(db, nf.id))!.stage, "not-a-fit");
  const second = (await createDeal(db, customer.id, deal("Gutters", 50000), "new", ME))!;
  await createDeal(db, customer.id, { ...deal("Euro job", 70000), currency: "EUR" }, "new", ME);
  const b = await board(db, { per: 100, closedDays: 30, currency: "USD" });
  assert.equal(b.totals.new.count, 2);
  assert.equal(b.totals.new.cents, "50000", "only the board's currency is added");
  assert.equal(b.totals.new.other, 1);
  assert.ok(b.cards.some((c) => c.id === second.id));
  const totals = await dealTotals(db, "USD", new Date(Date.now() - 86_400_000));
  assert.equal(totals.won.cents, "900000");
});

test("a quote accepted after the deal last moved wins it, once, whichever way the yes came", async (t) => {
  if (skip) return t.skip(skip);
  const { customer } = await createCustomer(db, { name: "Quo Te", email: "quote@example.com", stage: "lead" }, ME);
  const d = (await createDeal(db, customer.id, deal("Deck"), "quoted", ME))!;
  const [qt] = await db.sql<{ id: string }>`
    insert into quotes (number, email, currency, total_cents, deal_id, status) values ('Q-9001', 'quote@example.com', 'usd', 120000, ${d.id}::bigint, 'sent')
    returning id::text as id`;
  assert.equal((await getDeal(db, d.id))!.shown_cents, "120000", "a blank value shows the quote's total");
  assert.ok((await getDeal(db, d.id))!.from_quote);
  assert.deepEqual(await winFromQuotes(db, ME), [], "sent is not a yes");
  // The webhook's way: the quote accepted by a payment, no CRM page involved.
  await db.sql`update quotes set status = 'accepted', decided_at = now() where id = ${qt.id}::bigint`;
  assert.deepEqual((await winFromQuotes(db, "Stripe")).map((x) => x.title), ["Deck"]);
  assert.deepEqual(await winFromQuotes(db, "Stripe"), [], "twice wins nothing more");
  assert.equal((await getDeal(db, d.id))!.stage, "won");
  assert.equal((await getCustomer(db, customer.id))!.stage, "customer");
  // Moved back by hand afterwards: the earlier yes does not win it again.
  await setDealStage(db, d.id, "quoted", ME);
  assert.deepEqual(await winFromQuotes(db, ME), []);
});

test("follow-ups: due and upcoming, mine and everyone's, done once (even twice at once), moved; nothing planned", async (t) => {
  if (skip) return t.skip(skip);
  const today = "2026-10-08";
  const { customer } = await createCustomer(db, { name: "Fol Low", email: "follow@example.com", stage: "lead" }, ME);
  assert.ok((await nothingPlanned(db, null, 500)).some((u) => u.id === customer.id));
  const other = await createCustomer(db, { name: "Not Theirs", email: "else@example.com", stage: "lead" }, ME);
  const theirDeal = (await createDeal(db, other.customer.id, deal("Not theirs"), "new", ME))!;
  const late = (await addFollowUp(db, customer.id, { kind: "call", title: "Call", due_on: "2026-10-01", due_time: null, owner: ME, deal_id: theirDeal.id }, ME))!;
  assert.equal(late.deal_id, null, "a deal that is not theirs is left off");
  await addFollowUp(db, customer.id, { kind: "email", title: "Email", due_on: today, due_time: "10:00", owner: "bob@team.example", deal_id: null }, ME);
  await addFollowUp(db, customer.id, { kind: "meeting", title: "Meet", due_on: "2026-10-12", due_time: null, owner: ME, deal_id: null }, ME);
  await addFollowUp(db, customer.id, { kind: "task", title: "Far off", due_on: "2027-01-01", due_time: null, owner: ME, deal_id: null }, ME);
  assert.equal(await addFollowUp(db, "999999", { kind: "call", title: "x", due_on: today, due_time: null, owner: ME, deal_id: null }, ME), null);

  const mine = (await listFollowUps(db, "due", today, ME)).filter((f) => f.customer_id === customer.id);
  assert.deepEqual(mine.map((f) => f.title), ["Call"], "due is mine only");
  const all = (await listFollowUps(db, "due", today, null)).filter((f) => f.customer_id === customer.id);
  assert.deepEqual(all.map((f) => f.title), ["Call", "Email"], "overdue first");
  assert.deepEqual((await listFollowUps(db, "upcoming", today, null)).filter((f) => f.customer_id === customer.id).map((f) => f.title), ["Meet"], "the next 14 days only");
  const counts = await followUpCounts(db, today, ME);
  assert.ok(counts.overdue >= 1);
  assert.equal((await nextFollowUps(db, [customer.id])).get(customer.id)?.due_on, "2026-10-01");
  assert.ok(!(await nothingPlanned(db, null, 500)).some((u) => u.id === customer.id));

  const [one, two] = await Promise.all([doneFollowUp(db, late.id, "Spoke to them", ME), doneFollowUp(db, late.id, "Spoke to them", "bob@team.example")]);
  assert.deepEqual([one!.already, two!.already].sort(), [false, true], "ticked off once");
  const notes = await db.sql<{ kind: string; body: string }>`select kind, body from customer_notes where customer_id = ${customer.id}::bigint`;
  assert.deepEqual(notes, [{ kind: "call", body: "Call\nSpoke to them" }], "one note on the timeline");
  assert.ok((await getCustomer(db, customer.id))!.last_contact_at);
  assert.equal(await moveFollowUp(db, late.id, today, null, ME), false, "a done one does not move");
});

test("merge: everything moves, the address is kept, the other never matches again; a race merges once", async (t) => {
  if (skip) return t.skip(skip);
  const keep = (await createCustomer(db, { name: "Mia Merge", email: "mia@example.com", stage: "lead", tags: ["vip"] }, ME)).customer;
  const other = (await createCustomer(db, { name: "Mia Merge", email: "Mia.M@Work.example", phone: "555 321 9876", company: "Work Co", stage: "customer", tags: ["VIP", "work"], fields: { size: "L" } }, ME)).customer;
  await createDeal(db, other.id, deal("Her deal"), "new", ME);
  await addFollowUp(db, other.id, { kind: "call", title: "Her call", due_on: "2026-10-08", due_time: null, owner: ME, deal_id: null }, ME);
  await db.sql`insert into submissions (form_key, name, email, data, source) values ('contact', 'Mia', 'mia.m@work.example', '{"message": "work one"}', 'website')`;
  assert.ok((await possibleDuplicates(db, keep)).some((d) => d.id === other.id));
  const pv = (await mergePreview(db, keep.id, other.id))!;
  assert.deepEqual(pv.moves, { notes: 0, visits: 0, deals: 1, followUps: 1 });
  assert.deepEqual(pv.fills, ["phone", "company", "size", "also goes by mia.m@work.example"]);

  const results = await Promise.all([mergeCustomers(db, keep.id, other.id, ME), mergeCustomers(db, keep.id, other.id, ME)]);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  const k = (await getCustomer(db, keep.id))!;
  assert.deepEqual([k.phone, k.company, k.stage, k.other_emails, k.tags, k.fields], ["555 321 9876", "Work Co", "lead", ["mia.m@work.example"], ["vip", "work"], { size: "L" }]);
  const o = (await getCustomer(db, other.id))!;
  assert.deepEqual([o.email, o.phone, o.merged_into], [null, null, keep.id]);
  const [{ deals, fus }] = await db.sql<{ deals: number; fus: number }>`
    select (select count(*) from deals where customer_id = ${keep.id}::bigint)::int as deals, (select count(*) from follow_ups where customer_id = ${keep.id}::bigint)::int as fus`;
  assert.deepEqual([deals, fus], [1, 1]);
  assert.match((await db.sql<{ body: string }>`select body from customer_notes where customer_id = ${keep.id}::bigint`)[0].body, /^Merged #\d+ Mia Merge \(mia\.m@work\.example, 555 321 9876\) into this record\.$/);
  // Found by either address; a new record under the other address is not made.
  assert.equal((await findMatch(db, "MIA.M@work.example", null))!.id, keep.id);
  const again = await createCustomer(db, { name: "Mia at work", email: "mia.m@work.example", stage: "lead" }, ME);
  assert.deepEqual([again.created, again.customer.id], [false, keep.id]);
  assert.ok((await everythingFrom(db, k)).items.some((i) => i.kind === "submission"), "what came in under the other address");
  assert.deepEqual(await mergeCustomers(db, keep.id, keep.id, ME), { ok: false, reason: "same" });
  assert.deepEqual(await mergeCustomers(db, keep.id, other.id, ME), { ok: false, reason: "merged" });
});

test("the morning email goes once a day, at or after the hour, to owners with an email", async (t) => {
  if (skip) return t.skip(skip);
  const { customer } = await createCustomer(db, { name: "Dig Est", email: "digest@example.com", phone: "555 999 1111", stage: "lead" }, ME);
  await addFollowUp(db, customer.id, { kind: "call", title: "Ring Dig", due_on: "2026-10-08", due_time: null, owner: "zed@team.example", deal_id: null }, ME);
  await addFollowUp(db, customer.id, { kind: "call", title: "No mailbox", due_on: "2026-10-08", due_time: null, owner: "Zed", deal_id: null }, ME);
  const sent: { to: string; subject: string; text: string }[] = [];
  const send = async (m: { to: string; subject: string; text: string }) => (sent.push(m), { status: "sent" as const, via: "fake" });
  const early = await sendDigests(db, send, { timeZone: "America/Chicago", now: new Date("2026-10-08T11:00:00Z") });
  assert.ok(early.early, "6:00 in Chicago is before 7");
  const r = await sendDigests(db, send, { timeZone: "America/Chicago", now: new Date("2026-10-08T13:00:00Z") });
  const zed = sent.filter((m) => m.to === "zed@team.example");
  assert.equal(zed.length, 1);
  assert.match(zed[0].text, /Ring Dig \(Dig Est, 555 999 1111\)/);
  assert.ok(!sent.some((m) => m.to === "Zed"), "a name has no mailbox");
  assert.ok(r.sent >= 1);
  await sendDigests(db, send, { timeZone: "America/Chicago", now: new Date("2026-10-08T15:00:00Z") });
  assert.equal(sent.filter((m) => m.to === "zed@team.example").length, 1, "once a day");
  const [row] = await db.sql<{ status: string }>`select status from follow_up_digests where email = 'zed@team.example'`;
  assert.equal(row.status, "sent");
});

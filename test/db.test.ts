// Against a real Postgres when TEST_DATABASE_URL is set; skipped with a note
// otherwise. Each run works in its own schema (test/scratch.ts) and drops it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { q, type Db } from "../src/data/db";
import { applySchema } from "../src/data/migrate";
import { moveVisits, setup, setupKey, setupOnce } from "../src/db/setup";
import { cut } from "../src/admin/keyset";
import { createCustomer, findCustomer, findMatch, getCustomer, listPage, NO_FILTER, readListCursor, patchCustomer, retag, saveDetails, saveEveryone, setArchived, setStage } from "../src/crm/customers";
import { everythingFrom } from "../src/crm/history";
import { parseCsv } from "../src/crm/csv-read";
import { guessMap, planRows, runImport } from "../src/crm/importer";
import { home } from "../src/crm/home";
import { convertLead, leadsForOpenItems, listLeads } from "../src/crm/leads";
import { publishFields } from "../src/crm/fields";
import { loadTeam, setTeam } from "../src/crm/people";
import { addNote, listNotes } from "../src/customers/notes";
import { saveLead } from "../src/customers/customer";
import { addTask, nothingPlanned } from "../src/crm/tasks";
import { sendDigests } from "../src/crm/digest";
import { addStage, archiveStage, editStage, firstOpenStage, listStages, moveStage, restoreStage, seedStages } from "../src/crm/stages";
import { missingSentence, present } from "../src/crm/tables";
import { addEvent, customerEvents, eventsPage, getEvent, saveEvent, setEventStatus, type Event, type EventInput } from "../src/crm/events";
import type { StageConfig } from "../src/config-schema";
import { scratch, type Scratch } from "./scratch";

const STAGES: StageConfig[] = [
  { key: "new", label: "New", kind: "open" },
  { key: "contacted", label: "Contacted", kind: "open" },
  { key: "won", label: "Won", kind: "won" },
  { key: "lost", label: "Lost", kind: "lost" },
];
const DEAL_STAGES: StageConfig[] = [
  { key: "new", label: "New", kind: "open" },
  { key: "won", label: "Won", kind: "won" },
  { key: "lost", label: "Lost", kind: "lost" },
];
const SEEDS = { statuses: STAGES, dealStages: DEAL_STAGES };
const ME = "ann@team.example";

let s: Scratch | null = null;
let skip: string | false = false;
let db: Db;

before(async () => {
  const r = await scratch("db");
  if (typeof r === "string") skip = r;
  else {
    s = r;
    db = r.db;
  }
});
after(async () => {
  await s?.drop();
});

const rows = async (sql: string) => (await s!.pool.query(sql)).rows;

test("setup applies twice; stages are seeded once and only into an empty table", async (t) => {
  if (skip) return t.skip(skip);
  // Booking off: these tests start as a CRM in a project with no other app's tables.
  assert.deepEqual(await setup(db, SEEDS, { invoices: false, forms: false }), { seeded: 7 }, "four statuses and three deal stages");
  assert.deepEqual(await setup(db, SEEDS, { invoices: false, forms: false }), { seeded: 0 });
  await applySchema(db, readFileSync("schema.sql", "utf8"));
  assert.equal(await seedStages(db, "customers", [{ key: "other", label: "Other" }]), 0, "a table with rows is the owner's");
  assert.deepEqual((await listStages(db, "customers")).map((x) => x.key), ["new", "contacted", "won", "lost"]);
  assert.equal((await firstOpenStage(db, "customers"))?.key, "new");
});

test("setupOnce records the schema it applied and skips while it matches", async (t) => {
  if (skip) return t.skip(skip);
  const opts = { invoices: false, forms: false };
  await setupOnce(db, SEEDS, opts);
  const applied = async () => (await db.sql<{ schema_hash: string }>`select schema_hash from crm_setup where name = 'crm'`)[0]?.schema_hash;
  assert.equal(await applied(), setupKey(opts));
  // A table setup would make, dropped behind its back: a matching hash skips setup, so it stays gone.
  await db.sql`drop table customer_notes`;
  await setupOnce(db, SEEDS, opts);
  const notes = async () => (await db.sql<{ x: boolean }>`select to_regclass('customer_notes') is not null as x`)[0].x;
  assert.equal(await notes(), false, "skipped while the hash matches");
  // An older hash runs the whole setup again.
  await db.sql`update crm_setup set schema_hash = 'older' where name = 'crm'`;
  await setupOnce(db, SEEDS, opts);
  assert.equal(await notes(), true);
  assert.equal(await applied(), setupKey(opts));
  assert.notEqual(setupKey(opts), setupKey({ ...opts, invoices: true }), "other options, other schema");
});

test("add, find, update, stage, tags, archive", async (t) => {
  if (skip) return t.skip(skip);
  const a = await createCustomer(db, { name: "Ann Lee", email: " Ann.Lee@Example.com ", phone: "(555) 010-2030", stage: "new", tags: ["VIP"] }, ME);
  assert.equal(a.created, true);
  assert.equal(a.customer.email, "ann.lee@example.com");
  assert.equal(a.customer.created_by, ME);
  assert.equal((await findCustomer(db, "ANN.LEE@example.com"))?.id, a.customer.id);
  assert.equal((await findCustomer(db, "+1 555 010 2030"))?.id, a.customer.id);
  assert.equal((await findCustomer(db, a.customer.id))?.name, "Ann Lee");

  const p = await patchCustomer(db, a.customer.id, { company: "Lee Heating", fields: { truck: "Truck 2" } }, "bob@team.example");
  assert.ok(p.ok);
  const got = (await getCustomer(db, a.customer.id))!;
  assert.equal(got.company, "Lee Heating");
  assert.equal(got.phone, "(555) 010-2030", "untouched fields stay");
  assert.deepEqual(got.fields, { truck: "Truck 2" });
  assert.equal(got.updated_by, "bob@team.example");

  // fields: set one, clear one, keep the rest
  await patchCustomer(db, a.customer.id, { fields: { age: 3 } }, ME);
  await patchCustomer(db, a.customer.id, { unset: ["truck"] }, ME);
  assert.deepEqual((await getCustomer(db, a.customer.id))!.fields, { age: 3 });

  assert.equal((await setStage(db, a.customer.id, "won", ME))?.stage, "won");
  assert.equal(await setStage(db, a.customer.id, "nonsense", ME), null, "an unknown stage is refused");

  const tagged = await retag(db, a.customer.id, ["roof", "vip", "Roof"], [], ME);
  assert.deepEqual(tagged?.tags, ["VIP", "roof"]);
  assert.deepEqual((await retag(db, a.customer.id, [], ["ROOF"], ME))?.tags, ["VIP"]);

  assert.equal((await listPage(db, { ...NO_FILTER, q: "Heating" }, null, 10)).length, 1);
  assert.equal((await listPage(db, { ...NO_FILTER, q: "555 0102" }, null, 10)).length, 1, "phone digits match through punctuation");
  assert.equal((await listPage(db, { ...NO_FILTER, tag: "VIP" }, null, 10)).length, 1);
  assert.equal((await listPage(db, { ...NO_FILTER, stage: "new" }, null, 10)).length, 0);

  assert.ok((await setArchived(db, a.customer.id, true, ME))?.archived_at);
  assert.equal((await listPage(db, NO_FILTER, null, 10)).length, 0);
  assert.equal((await listPage(db, { ...NO_FILTER, archived: true }, null, 10)).length, 1);
  assert.equal((await setArchived(db, a.customer.id, false, ME))?.archived_at, null);
});

test("email is unique and case-blind; phone matches only where an email is missing", async (t) => {
  if (skip) return t.skip(skip);
  const one = await createCustomer(db, { name: "Cy", email: "Cy@Example.com", stage: "new" }, ME);
  const two = await createCustomer(db, { name: "Cy again", email: "cy@EXAMPLE.com", stage: "new" }, ME);
  assert.equal(two.created, false);
  assert.equal(two.customer.id, one.customer.id);
  await assert.rejects(db.sql`insert into customers (name, email, stage) values ('x', 'CY@example.COM', 'new')`, (e: { code?: string }) => e.code === "23505");
  // Saving another customer onto a taken email is refused, not a crash.
  const other = await createCustomer(db, { name: "Di", email: "di@example.com", stage: "new" }, ME);
  const r = await saveDetails(db, other.customer.id, { ...other.customer, email: "CY@example.com", fields: {}, unset: [] }, ME);
  assert.deepEqual(r, { ok: false, reason: "email-taken" });
  // Phone only: matched by phone; two different emails on one phone are two people.
  const ph = await createCustomer(db, { name: "Ed", phone: "555-777-1234", stage: "new" }, ME);
  assert.equal((await createCustomer(db, { name: "Ed", phone: "+1 (555) 777 1234", stage: "new" }, ME)).created, false);
  assert.equal((await findMatch(db, "ed@example.com", "5557771234"))?.id, ph.customer.id, "an email-less customer matches by phone");
  await createCustomer(db, { name: "Fay", email: "fay@example.com", phone: "555 888 0000", stage: "new" }, ME);
  assert.equal((await createCustomer(db, { name: "Gus", email: "gus@example.com", phone: "555 888 0000", stage: "new" }, ME)).created, true);
  // A customer with neither an email nor a phone is allowed.
  assert.equal((await createCustomer(db, { name: "Walk-in", stage: "new" }, ME)).created, true);
});

test("notes stamp who and when, in the business zone, and move the last contact", async (t) => {
  if (skip) return t.skip(skip);
  const { customer: c } = await createCustomer(db, { name: "Hal", email: "hal@example.com", stage: "new" }, ME);
  await addNote(db, c.id, { kind: "note", body: "Prefers mornings", timeZone: "America/Chicago" }, ME);
  assert.equal((await getCustomer(db, c.id))!.last_contact_at, null, "a plain note is not contact");
  const call = await addNote(db, c.id, { kind: "call", body: "Called back", at: "2026-03-08 09:30:00", timeZone: "America/Chicago" }, "bob@team.example");
  // 9:30 on the morning US clocks went forward is CDT, UTC-5.
  assert.equal(call!.happened_at.toISOString(), "2026-03-08T14:30:00.000Z");
  assert.equal((await getCustomer(db, c.id))!.last_contact_at!.toISOString(), "2026-03-08T14:30:00.000Z");
  const notes = await listNotes(db, c.id);
  assert.deepEqual(notes.map((n) => [n.kind, n.author]), [["note", ME], ["call", "bob@team.example"]]);
  assert.equal(await addNote(db, "999999", { kind: "note", body: "x", timeZone: "UTC" }, ME), null);
  // An older contact never moves it back.
  await addNote(db, c.id, { kind: "email", body: "old", at: "2025-01-01 10:00", timeZone: "UTC" }, ME);
  assert.equal((await getCustomer(db, c.id))!.last_contact_at!.toISOString(), "2026-03-08T14:30:00.000Z");
});

test("stages: add, rename, kind, move, archive (refused while in use or last open), restore", async (t) => {
  if (skip) return t.skip(skip);
  const add = await addStage(db, "customers", "Estimate sent", "open", ME);
  assert.ok(add.ok && add.stage?.key === "estimate-sent");
  const again = await addStage(db, "customers", "Estimate sent", "open", ME);
  assert.ok(again.ok && again.stage?.key === "estimate-sent-2");
  await moveStage(db, "customers", "estimate-sent", "up", ME);
  await moveStage(db, "customers", "estimate-sent", "up", ME);
  assert.deepEqual((await listStages(db, "customers")).map((x) => x.key).slice(0, 4), ["new", "contacted", "estimate-sent", "won"]);
  assert.ok((await editStage(db, "customers", "estimate-sent", { label: "Quoted" }, ME)).ok);

  const { customer } = await createCustomer(db, { name: "Ivy", email: "ivy@example.com", stage: "estimate-sent" }, ME);
  assert.deepEqual(await archiveStage(db, "customers", "estimate-sent", null, ME), { ok: false, reason: "in-use", count: 1 });
  assert.deepEqual(await archiveStage(db, "customers", "estimate-sent", "nowhere", ME), { ok: false, reason: "bad-target" });
  assert.deepEqual(await archiveStage(db, "customers", "estimate-sent", "contacted", ME), { ok: true });
  assert.equal((await getCustomer(db, customer.id))!.stage, "contacted");
  assert.ok(!(await listStages(db, "customers")).some((x) => x.key === "estimate-sent"));
  assert.ok((await restoreStage(db, "customers", "estimate-sent", ME)).ok);
  assert.equal((await listStages(db, "customers")).at(-1)?.key, "estimate-sent");

  // There is always an open stage.
  for (const k of ["estimate-sent", "estimate-sent-2"]) assert.ok((await archiveStage(db, "customers", k, null, ME)).ok);
  const open = (await listStages(db, "customers")).filter((x) => x.kind === "open").map((x) => x.key);
  assert.deepEqual(open, ["new", "contacted"]);
  await db.sql`update customers set stage = 'new' where stage = 'contacted'`;
  assert.ok((await archiveStage(db, "customers", "contacted", null, ME)).ok);
  assert.deepEqual(await archiveStage(db, "customers", "new", "won", ME), { ok: false, reason: "last-open" });
  assert.deepEqual(await editStage(db, "customers", "new", { kind: "won" }, ME), { ok: false, reason: "last-open" });
  assert.ok((await restoreStage(db, "customers", "contacted", ME)).ok);
});

test("Home, with none of the other apps' tables", async (t) => {
  if (skip) return t.skip(skip);
  const p = await present(db);
  assert.deepEqual(p, { submissions: false, forms: false, payments: false, quotes: false, invoices: false });
  const h = await home(db, { timeZone: "UTC", currency: "USD", invoiceCurrency: "usd", user: ME });
  assert.deepEqual([h.leads, h.owed, h.newLeads, h.events, h.closing], [{ current: 0, previous: 0 }, null, [], [], []]);
  assert.match(missingSentence(p)!, /no form submissions or payments/);
  assert.equal((await everythingFrom(db, { email: "ann.lee@example.com", phone: null })).items.length, 0);
});

test("setup saves everyone and makes a lead of each open request: by email, else by phone; not spam, not a form with leads off", async (t) => {
  if (skip) return t.skip(skip);
  await applySchema(db, readFileSync("test/fixtures/other-apps.sql", "utf8"));
  await db.transaction([
    q`insert into forms (key, title) values ('quote', 'Quote request')`,
    q`insert into forms (key, title, leads) values ('newsletter', 'Newsletter', false)`,
    q`insert into submissions (form_key, name, email, phone, data, source, status, created_at) values
        ('quote', 'Jo Park', 'JO@example.com', null, '{"message": "Need a new furnace"}', 'website', 'new', '2026-10-01 10:00:00.000001+00'),
        ('quote', 'Jo Park', 'jo@example.com', null, '{}', 'website', 'read', '2026-10-01 10:00:00.000001+00'),
        ('quote', 'Spammer', 'spam@example.com', null, '{}', 'website', 'spam', '2026-10-01 11:00:00+00'),
        ('newsletter', 'News', 'news@example.com', null, '{}', 'website', 'new', '2026-10-01 12:00:00+00'),
        ('quote', null, null, '555 777 1234', '{}', 'website', 'new', '2026-10-01 09:00:00+00'),
        -- The Website's copy of Ann's booking (booking page): her timeline shows the booking once.
        ('book', 'Ann Lee', 'ann.lee@example.com', null, '{"service": "Estimate visit"}', 'website', 'new', '2026-10-01 10:00:00.000002+00')`,
    q`insert into resources (name, time_zone) values ('Sam', 'America/Chicago')`,
    q`insert into booking_types (slug, name, location_kind) values ('estimate', 'Estimate visit', 'their_place')`,
    q`insert into bookings (type_id, resource_id, starts_at, ends_at, name, email, status, location_kind, location, created_at)
        select (select id from booking_types), id, '2026-10-05 15:00+00', '2026-10-05 16:00+00', 'Ann Lee', 'ann.lee@example.com', 'confirmed',
               'their_place', '9 Oak Lane', '2026-10-01 10:00:00.000001+00' from resources`,
    q`insert into payments (email, name, amount_cents, currency, status, created_at) values
        ('kim@example.com', 'Kim', 12500, 'usd', 'paid', '2026-10-02 08:00+00'),
        ('kim@example.com', 'Kim', 999, 'usd', 'pending', '2026-10-02 09:00+00')`,
  ]);
  const [jo] = await rows("select id::text as id, created_at from submissions where name = 'Jo Park' and status = 'new'");
  await saveEveryone(db);
  await leadsForOpenItems(db);
  const saved = (await findCustomer(db, "jo@example.com"))!;
  assert.deepEqual([saved.name, saved.source, saved.stage], ["Jo Park", "Quote request", "new"]);
  assert.equal(new Date(saved.last_contact_at!).getTime(), new Date(jo.created_at).getTime(), "first contact is when they wrote");
  assert.equal((await findCustomer(db, "kim@example.com"))?.source, "Payment");
  assert.equal(await findCustomer(db, "spam@example.com"), null, "spam saves no one");
  assert.ok(await findCustomer(db, "news@example.com"), "a newsletter sign-up is a contact");

  // A lead per open request, on its person: Jo's two, and the phone-only one on the phone-only customer.
  // Not the newsletter, not spam, not the booking page's copy, not Ann's booking (it is past).
  const leads = await listLeads(db, { status: "open" });
  assert.deepEqual(leads.map((l) => `${l.customer_name}: ${l.title}`).sort(), ["Ed: Quote request", "Jo Park: Quote request", "Jo Park: Quote request"]);
  const joLead = leads.find((l) => l.submission_id === jo.id)!;
  assert.equal(joLead.said, "Need a new furnace", "what they wrote");

  // Converted into a deal, its request is done in the forms list too.
  const [deal] = await db.sql<{ id: string }>`insert into deals (customer_id, title, stage) values (${saved.id}::bigint, 'Furnace', 'new') returning id::text as id`;
  assert.equal(await convertLead(db, joLead.id, deal.id, ME), true);
  assert.equal(await convertLead(db, joLead.id, deal.id, ME), false, "already converted");
  const [done] = await rows(`select status, updated_by::text as by from submissions where id = ${Number(jo.id)}`);
  assert.deepEqual(done, { status: "done", by: ME });
  const history = await everythingFrom(db, saved);
  assert.deepEqual(history.items.map((i) => `${i.kind}:${i.status}`), ["submission:read", "submission:done"]);
  const ann = (await findCustomer(db, "ann.lee@example.com"))!;
  assert.deepEqual((await everythingFrom(db, ann)).items, [], "her booking is not on the timeline");
  assert.deepEqual((await customerEvents(db, ann.id)).map((e) => e.what), ["Estimate visit"], "it is one of her events");
});

test("nothing planned: everyone in play with no task and nothing booked", async (t) => {
  if (skip) return t.skip(skip);
  const { customer } = await createCustomer(db, { name: "Quiet", email: "quiet@example.com", stage: "new", last_contact_at: "2026-01-01T00:00:00Z" }, ME);
  assert.ok((await nothingPlanned(db, null, 500)).some((c) => c.id === customer.id), "an open status with nothing planned");
  // Added at 23:00 yesterday is a day ago, however few hours have passed since.
  await db.sql`update customers set last_contact_at = null, created_at = date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - interval '1 hour' where id = ${customer.id}::bigint`;
  assert.equal((await nothingPlanned(db, null, 500, "UTC")).find((c) => c.id === customer.id)?.quiet_days, 1, "calendar days, not 24-hour spans");
  await setStage(db, customer.id, "won", ME);
  assert.ok(!(await nothingPlanned(db, null, 500)).some((c) => c.id === customer.id), "a won status with no open deal is not in play");
});

test("import: dedupe by email then phone, fill only what is empty, dry run writes nothing", async (t) => {
  if (skip) return t.skip(skip);
  const csv = parseCsv(
    [
      "Name,Email,Phone,Company,Tags,Stage,Notes",
      "Ann L,ANN.LEE@example.com,,New Co,import;VIP,Lost,from the sheet",
      "Ed Smith,,555.777.1234,Ed Plumbing,,,",
      "Nia,nia@example.com,555 222 3333,,,,",
      "Nia Again,,(555) 222-3333,,repeat,,",
      "Oz,oz@example.com,,Oz Ltd,,Won,",
      ",,,,,,just a note",
    ].join("\n"),
  );
  const stages = await listStages(db, "customers");
  const plan = planRows(csv, guessMap(csv[0], []), [], stages);
  const before = await rows("select id, name, email::text, phone, company, tags, stage, notes, updated_at from customers order by id");

  const dry = await runImport(db, plan, { dryRun: true, defaultStage: "new", user: ME });
  assert.deepEqual(
    { created: dry.created, updated: dry.updated, unchanged: dry.unchanged, merged: dry.merged, skipped: dry.skipped },
    { created: 2, updated: 2, unchanged: 0, merged: 1, skipped: 1 },
  );
  assert.deepEqual(await rows("select id, name, email::text, phone, company, tags, stage, notes, updated_at from customers order by id"), before, "a dry run changes nothing");

  const real = await runImport(db, plan, { defaultStage: "new", user: ME });
  assert.deepEqual([real.created, real.updated], [2, 2]);
  const ann = (await findCustomer(db, "ann.lee@example.com"))!;
  assert.equal(ann.name, "Ann Lee", "a name already there is kept");
  assert.equal(ann.company, "Lee Heating", "a company already there is kept");
  assert.equal(ann.stage, "won", "the stage is kept without --overwrite");
  assert.equal(ann.notes, "from the sheet", "an empty field is filled");
  assert.deepEqual(ann.tags, ["VIP", "import"]);
  const ed = (await findCustomer(db, "5557771234"))!;
  assert.equal(ed.company, "Ed Plumbing", "matched by phone, filled");
  const nia = (await findCustomer(db, "nia@example.com"))!;
  assert.deepEqual(nia.tags, ["repeat"], "the second row by phone folded into the first");
  assert.equal((await findCustomer(db, "oz@example.com"))!.stage, "won");
  assert.equal((await rows("select count(*)::int as n from customers where email = 'nia@example.com' or phone like '%222%'"))[0].n, 1);

  // A row with only a name matches a customer with only that name.
  const bare = planRows(parseCsv("Name,Tags\nWalk-in,cash\nZed,"), { name: "Name", tags: "Tags" }, [], stages);
  const b1 = await runImport(db, bare, { defaultStage: "new", user: ME });
  assert.deepEqual([b1.created, b1.updated], [1, 1], "Walk-in (no email, no phone) was already here");
  assert.deepEqual([(await runImport(db, bare, { defaultStage: "new", user: ME })).created], [0]);

  // Again: nothing new, nothing changed.
  const third = await runImport(db, plan, { defaultStage: "new", user: ME });
  assert.deepEqual([third.created, third.updated], [0, 0]);

  // --overwrite replaces what is there.
  await runImport(db, plan, { defaultStage: "new", user: ME, overwrite: true });
  const ann2 = (await findCustomer(db, "ann.lee@example.com"))!;
  assert.deepEqual([ann2.name, ann2.company, ann2.stage], ["Ann L", "New Co", "lost"]);
});

test("import gives a customer with no last contact their latest submission, booking or payment", async (t) => {
  if (skip) return t.skip(skip);
  const dated = await createCustomer(db, { name: "Dated", email: "dated@example.com", stage: "new", last_contact_at: "2026-12-01T00:00:00Z" }, ME);
  await createCustomer(db, { name: "Undated", email: "undated@example.com", stage: "new" }, ME);
  await db.transaction([
    q`insert into submissions (form_key, name, email, data, source, status, created_at) values
        ('quote', 'Undated', 'undated@example.com', '{}', 'website', 'new', '2026-06-01 10:00+00'),
        ('quote', 'Undated', 'undated@example.com', '{}', 'website', 'spam', '2026-09-30 10:00+00'),
        ('quote', 'Dated', 'dated@example.com', '{}', 'website', 'new', '2026-07-01 10:00+00')`,
    q`insert into bookings (type_id, resource_id, starts_at, ends_at, name, email, location_kind, created_at)
        select (select id from booking_types limit 1), id, '2026-07-10 15:00+00', '2026-07-10 16:00+00', 'Undated', 'undated@example.com', 'our_place', '2026-07-02 10:00+00' from resources limit 1`,
    q`insert into payments (email, name, amount_cents, currency, status, created_at) values
        ('fresh@example.com', 'Fresh', 100, 'usd', 'paid', '2026-05-05 10:00+00'),
        ('fresh@example.com', 'Fresh', 100, 'usd', 'pending', '2026-09-09 10:00+00')`,
  ]);
  const csv = parseCsv(["Name,Email,Last contact", "Undated,UNDATED@example.com,", "Dated,dated@example.com,", "Fresh,fresh@example.com,", "Sheet,sheet@example.com,2026-03-03"].join("\n"));
  const plan = planRows(csv, guessMap(csv[0], []), [], await listStages(db, "customers"));

  const dry = await runImport(db, plan, { dryRun: true, defaultStage: "new", user: ME });
  assert.deepEqual([dry.created, dry.updated, dry.unchanged], [2, 1, 1]);
  assert.equal((await findCustomer(db, "undated@example.com"))!.last_contact_at, null, "a dry run writes nothing");

  await runImport(db, plan, { defaultStage: "new", user: ME });
  const at = async (email: string) => (await findCustomer(db, email))!.last_contact_at?.toISOString() ?? null;
  assert.equal(await at("undated@example.com"), "2026-07-02T10:00:00.000Z", "the latest of submission and booking; spam is not contact");
  assert.equal(await at("dated@example.com"), "2026-12-01T00:00:00.000Z", "never moved earlier");
  assert.equal((await findCustomer(db, "dated@example.com"))!.updated_at.getTime(), dated.customer.updated_at.getTime(), "a customer with a date is untouched");
  assert.equal(await at("fresh@example.com"), "2026-05-05T10:00:00.000Z", "a new customer from a paid payment; a pending one is not contact");
  assert.equal((await at("sheet@example.com"))?.slice(0, 10), "2026-03-03", "the file's own date stands");
});

// Review regressions.

test("racing creates of one person make one customer: by email, by phone only, by bare name", async (t) => {
  if (skip) return t.skip(skip);
  const many = <T>(n: number, f: () => Promise<T>) => Promise.all(Array.from({ length: n }, f));
  const byPhone = await many(6, () => createCustomer(db, { name: "Race Phone", phone: "555 404 0001", stage: "new" }, ME));
  assert.equal(byPhone.filter((r) => r.created).length, 1);
  assert.equal(new Set(byPhone.map((r) => r.customer.id)).size, 1);
  const byEmail = await many(6, () => createCustomer(db, { name: "Race Mail", email: "race@example.com", stage: "new" }, ME));
  assert.equal(byEmail.filter((r) => r.created).length, 1);
  assert.equal(new Set(byEmail.map((r) => r.customer.id)).size, 1);
  // An email-and-phone create and a phone-only create of the same number at once are one person.
  const mixed = await Promise.all([
    createCustomer(db, { name: "Mixed", email: "mixed@example.com", phone: "555 404 0002", stage: "new" }, ME),
    createCustomer(db, { name: "Mixed", phone: "(555) 404-0002", stage: "new" }, ME),
  ]);
  assert.equal(mixed.filter((r) => r.created).length, 1);
  // Creating a plain customer with only a name is still always a new one (two John Smiths).
  const plain = await many(2, () => createCustomer(db, { name: "Same Name", stage: "new" }, ME));
  assert.equal(plain.filter((r) => r.created).length, 2);
});

test("a phone with an extension matches the same number without one, in every query", async (t) => {
  if (skip) return t.skip(skip);
  const { customer } = await createCustomer(db, { name: "Ext Office", phone: "555-606-1000 ext. 214", stage: "new" }, ME);
  assert.equal((await findMatch(db, null, "(555) 606-1000"))?.id, customer.id);
  assert.equal((await createCustomer(db, { name: "Ext Office", phone: "+1 555 606 1000", stage: "new" }, ME)).created, false);
  await db.sql`insert into submissions (form_key, name, phone, source, data) values ('quote', 'Front desk', '555 606 1000 x9', 'website', '{"message": "ext test"}')`;
  const history = await everythingFrom(db, customer);
  assert.ok(history.items.some((i) => i.kind === "submission"), "the submission shows on the customer");
  const plan = planRows(parseCsv("Name,Phone,Company\nOffice,5556061000 x 3,Ext Co"), { name: "Name", phone: "Phone", company: "Company" }, [], await listStages(db, "customers"));
  const r = await runImport(db, plan, { defaultStage: "new", user: ME });
  assert.deepEqual([r.created, r.updated], [0, 1]);
  assert.equal((await getCustomer(db, customer.id))!.company, "Ext Co");
});

test("customer list paging walks rows tied to the microsecond exactly once", async (t) => {
  if (skip) return t.skip(skip);
  for (const n of [1, 2, 3, 4]) await createCustomer(db, { name: `Tie ${n}`, email: `tie${n}@example.com`, stage: "new" }, ME);
  await db.sql`update customers set last_contact_at = '2030-01-01 00:00:00.000001+00' where email like 'tie%'`;
  await db.sql`update customers set last_contact_at = '2030-01-01 00:00:00.000002+00' where email = 'tie4@example.com'`;
  const f = { ...NO_FILTER, q: "Tie " };
  const seen: string[] = [];
  let after = null;
  for (let i = 0; i < 10; i++) {
    const { page, next } = cut(await listPage(db, f, after, 1), 1);
    seen.push(...page.map((c) => c.name));
    if (!next) break;
    after = readListCursor(next);
    assert.ok(after, "our own cursor reads back");
  }
  assert.deepEqual(seen, ["Tie 4", "Tie 3", "Tie 2", "Tie 1"]);
});

test("two stage changes at once cannot leave the pipeline without an open stage", async (t) => {
  if (skip) return t.skip(skip);
  // Make the open stages exactly two empty ones.
  const a = await addStage(db, "customers", "Race A", "open", ME);
  const b = await addStage(db, "customers", "Race B", "open", ME);
  assert.ok(a.ok && b.ok);
  const others = (await listStages(db, "customers")).filter((x) => x.kind === "open" && x.key !== a.stage!.key && x.key !== b.stage!.key);
  for (const o of others) await editStage(db, "customers", o.key, { kind: "lost" }, ME);
  const results = await Promise.all([archiveStage(db, "customers", a.stage!.key, null, ME), archiveStage(db, "customers", b.stage!.key, null, ME)]);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.ok(results.some((r) => !r.ok && r.reason === "last-open"));
  assert.ok((await firstOpenStage(db, "customers")) !== null);
  // Two kind changes at once: the same rule.
  const c = await addStage(db, "customers", "Race C", "open", ME);
  const left = (await listStages(db, "customers")).filter((x) => x.kind === "open").map((x) => x.key);
  assert.equal(left.length, 2);
  const kinds = await Promise.all(left.map((k) => editStage(db, "customers", k, { kind: "won" }, ME)));
  assert.equal(kinds.filter((r) => r.ok).length, 1);
  assert.ok((await firstOpenStage(db, "customers")) !== null);
  // Put things back for anything after this.
  for (const o of others) await editStage(db, "customers", o.key, { kind: "open" }, ME);
  assert.ok(c.ok);
});

test("events: scheduled, then completed, no-show or cancelled; completed is contact; the list's views and paging", async (t) => {
  if (skip) return t.skip(skip);
  const { customer } = await createCustomer(db, { name: "Ev Ent", email: "event@example.com", phone: "555 919 7001", stage: "new" }, ME);
  const [sam] = await db.sql<{ id: string }>`insert into resources (name, email, time_zone) values ('Sam', 'sam@team.example', 'UTC') returning id::text as id`;
  const base: EventInput = { title: "Tune-up", type_id: null, at: "2099-01-15 09:30:00", timeZone: "America/Chicago", minutes: 90, resource_id: sam.id, location: "9 Oak Lane", amount_cents: null, currency: "USD", notes: null, fields: {}, deal_id: null };

  const later = await addEvent(db, customer, { ...base, fields: { truck: "Truck 2" } }, ME);
  assert.ok(later);
  assert.equal(later.starts_at.toISOString(), "2099-01-15T15:30:00.000Z", "a wall time in the business's zone");
  assert.equal(later.ends_at.toISOString(), "2099-01-15T17:00:00.000Z");
  assert.deepEqual([later.what, later.status, later.customer_id, later.host_name, later.email, later.source], ["Tune-up", "confirmed", customer.id, "Sam", "event@example.com", "crm"]);
  assert.equal((await getCustomer(db, customer.id))!.last_contact_at, null, "scheduled is not contact");
  // Someone with one coming up is not waiting on a task, and a team-made one is not a lead.
  await db.sql`update customers set last_contact_at = now() - interval '60 days' where id = ${customer.id}::bigint`;
  assert.ok(!(await nothingPlanned(db, null, 500)).some((c) => c.id === customer.id));
  await leadsForOpenItems(db);
  assert.equal((await db.sql`select 1 from leads where booking_id = ${later.id}::bigint`).length, 0);

  const past = await addEvent(db, customer, { ...base, title: "Repair", at: "2026-09-30 14:00:00", amount_cents: 24500 }, ME);
  assert.equal(past!.amount_cents, "24500");
  assert.equal(await setEventStatus(db, later.id, "completed", ME), null, "not completed before it starts");
  const completed = await setEventStatus(db, past!.id, "completed", ME);
  assert.equal(completed!.status, "completed");
  assert.equal((await getCustomer(db, customer.id))!.last_contact_at!.toISOString(), "2026-09-30T19:00:00.000Z", "completed moves the last contact");
  assert.equal(await setEventStatus(db, past!.id, "completed", ME), null, "nothing to change");

  // Save merges fields and removes unset ones; a new time raises SEQUENCE so the calendar copy moves.
  const [{ sequence: before }] = await db.sql<{ sequence: number }>`select sequence from bookings where id = ${later.id}::bigint`;
  const saved = await saveEvent(db, later.id, { ...base, title: "Tune-up and filter", at: "2099-01-16 09:30:00", fields: { van: "Van 1" }, unset: ["truck"] }, customer.id, ME);
  assert.deepEqual([saved!.what, saved!.fields], ["Tune-up and filter", { van: "Van 1" }]);
  const [{ sequence: after }] = await db.sql<{ sequence: number }>`select sequence from bookings where id = ${later.id}::bigint`;
  assert.equal(after, before + 1);
  assert.equal(await saveEvent(db, "999999", { ...base, unset: [] }, customer.id, ME), null);

  await assert.rejects(db.sql`update bookings set amount_cents = -1 where id = ${later.id}::bigint`);

  const cancelled = await addEvent(db, customer, { ...base, title: "Called off", at: "2099-01-01 08:00:00" }, ME);
  await setEventStatus(db, cancelled!.id, "cancelled", ME);
  assert.deepEqual((await customerEvents(db, customer.id)).map((e) => e.what), ["Tune-up and filter", "Called off", "Repair"], "scheduled first, then newest first");
  const mine = (rows: Event[]) => rows.filter((e) => e.customer_id === customer.id).map((e) => e.what);
  assert.deepEqual(mine(await eventsPage(db, { view: "upcoming", host: null, q: null }, null, 50)), ["Tune-up and filter"]);
  assert.deepEqual(mine(await eventsPage(db, { view: "past", host: null, q: null }, null, 50)), ["Called off", "Repair"]);
  assert.equal((await eventsPage(db, { view: "all", host: sam.id, q: "repair" }, null, 50)).length, 1, "by person, and q finds what it is");
  assert.equal(mine(await eventsPage(db, { view: "all", host: null, q: "ev ent" }, null, 50)).length, 3, "q finds the customer's name");

  // Paging walks every row once, ties on the time included.
  for (let i = 0; i < 5; i++) await addEvent(db, customer, { ...base, title: `Batch ${i}`, at: "2099-06-01 10:00:00" }, ME);
  const seen: string[] = [];
  let cursor = null;
  for (;;) {
    const { page, next } = cut(await eventsPage(db, { view: "upcoming", host: null, q: "batch" }, cursor, 2), 2);
    seen.push(...page.map((e) => e.what));
    if (!next) break;
    cursor = readListCursor(next);
  }
  assert.deepEqual(seen, ["Batch 0", "Batch 1", "Batch 2", "Batch 3", "Batch 4"]);

  // For one of the customer's deals, as a task can be; another customer's deal is left off.
  const [ours] = await db.sql<{ id: string }>`insert into deals (customer_id, title, stage) values (${customer.id}::bigint, 'New furnace', 'new') returning id::text as id`;
  const { customer: other } = await createCustomer(db, { name: "Not Them", email: "notthem@example.com", stage: "new" }, ME);
  const [theirs] = await db.sql<{ id: string }>`insert into deals (customer_id, title, stage) values (${other.id}::bigint, 'Theirs', 'new') returning id::text as id`;
  const visit = await addEvent(db, customer, { ...base, title: "Estimate", deal_id: ours.id }, ME);
  assert.deepEqual([visit!.deal_id, visit!.deal_title], [ours.id, "New furnace"]);
  assert.equal((await addEvent(db, customer, { ...base, title: "Stray", deal_id: theirs.id }, ME))!.deal_id, null);
  assert.deepEqual((await customerEvents(db, customer.id, 100, ours.id)).map((e) => e.what), ["Estimate"], "the deal's own");
  assert.equal((await saveEvent(db, visit!.id, { ...base, title: "Estimate", deal_id: null, unset: [] }, customer.id, ME))!.deal_id, null, "taken off it");
});

test("an event carries its customer's details as they change", async (t) => {
  if (skip) return t.skip(skip);
  const { customer } = await createCustomer(db, { name: "Pho Only", email: null, phone: "555 919 7002", stage: "new" }, ME);
  const e = await addEvent(db, customer, { title: "Visit", type_id: null, at: "2099-02-01 09:00:00", timeZone: "UTC", minutes: 60, resource_id: null, location: null, amount_cents: null, currency: "USD", notes: null, fields: {}, deal_id: null }, ME);
  assert.equal(e!.email, null);
  const r = await patchCustomer(db, customer.id, { name: "Pho Found", email: "found@example.com" }, ME);
  assert.ok(r.ok);
  const [b] = await db.sql`select name, email::text as email, phone from bookings where id = ${e!.id}::bigint`;
  assert.deepEqual({ ...b }, { name: "Pho Found", email: "found@example.com", phone: "555 919 7002" }, "the invoice and the booker's emails reach the new address");
});

test("an online booking is an event of the customer its email belongs to; saved at setup, it brings their address and is their lead", async (t) => {
  if (skip) return t.skip(skip);
  const [type] = await db.sql<{ id: string }>`insert into booking_types (slug, name, location_kind) values ('install', 'Installation', 'their_place') returning id::text as id`;
  const [b] = await db.sql<{ id: string }>`
    insert into bookings (type_id, starts_at, ends_at, name, email, phone, location_kind, location, answers, source)
    values (${type.id}::bigint, now() + interval '3 days', now() + interval '3 days 2 hours', 'Joy Park', 'joy@example.com',
            '555 202 3030', 'their_place', '44 Birch Road', '{"notes": "Side gate is open"}'::jsonb, 'website')
    returning id::text as id`;
  const before = await getEvent(db, b.id);
  assert.deepEqual([before!.what, before!.customer_id, before!.name], ["Installation", null, "Joy Park"], "not a customer yet");

  await saveEveryone(db);
  await leadsForOpenItems(db);
  const added = (await findCustomer(db, "joy@example.com"))!;
  assert.deepEqual([added.address, added.source], ["44 Birch Road", "Booking: Installation"], "their place is their address");
  assert.equal((await getEvent(db, b.id))!.customer_id, added.id, "matched by email");
  assert.ok((await customerEvents(db, added.id)).some((e) => e.id === b.id));
  const [lead] = await db.sql<{ id: string; title: string; c: string }>`select id::text as id, title, customer_id::text as c from leads where booking_id = ${b.id}::bigint`;
  assert.deepEqual([lead.title, lead.c], ["Installation", added.id], "it is their lead");
  // Converted into a deal, the booking it came from is the deal's.
  const [deal] = await db.sql<{ id: string }>`insert into deals (customer_id, title, stage) values (${added.id}::bigint, 'Install', 'new') returning id::text as id`;
  assert.equal(await convertLead(db, lead.id, deal.id, ME), true);
  assert.equal((await getEvent(db, b.id))!.deal_id, deal.id);
});

test("an online booking with no email is the event of the customer its phone belongs to", async (t) => {
  if (skip) return t.skip(skip);
  const { customer } = await createCustomer(db, { name: "Cal Phone", email: null, phone: "(555) 404-7070", stage: "new" }, ME);
  const [b] = await db.sql<{ id: string }>`
    insert into bookings (starts_at, ends_at, name, phone, location_kind, source)
    values (now() + interval '4 days', now() + interval '4 days 1 hour', 'Cal', '555 404 7070 x2', 'phone', 'website') returning id::text as id`;
  assert.equal((await getEvent(db, b.id))!.customer_id, customer.id);
  assert.ok((await customerEvents(db, customer.id)).some((e) => e.id === b.id));
});

test("a booking held for a form still being paid is no one's event: not listed, not planned, not a lead", async (t) => {
  if (skip) return t.skip(skip);
  const { customer } = await createCustomer(db, { name: "Hal Held", email: "held@example.com", stage: "new" }, ME);
  await db.sql`update customers set last_contact_at = now() - interval '30 days' where id = ${customer.id}::bigint`;
  const [b] = await db.sql<{ id: string }>`
    insert into bookings (starts_at, ends_at, name, email, location_kind, source, hold_until)
    values (now() + interval '5 days', now() + interval '5 days 1 hour', 'Hal Held', 'held@example.com', 'phone', 'website', now() + interval '40 minutes')
    returning id::text as id`;
  assert.equal(await getEvent(db, b.id), null);
  assert.ok(!(await customerEvents(db, customer.id)).some((e) => e.id === b.id));
  assert.ok(!(await eventsPage(db, { view: "upcoming", host: null, q: null }, null, 500)).some((e) => e.id === b.id));
  assert.ok((await nothingPlanned(db, null, 500)).some((c) => c.id === customer.id), "a held time is not something planned");
  await leadsForOpenItems(db);
  assert.equal((await db.sql`select 1 from leads where booking_id = ${b.id}::bigint`).length, 0);
  // Paid: the hold ends and it is theirs.
  await db.sql`update bookings set hold_until = null where id = ${b.id}::bigint`;
  assert.equal((await getEvent(db, b.id))!.customer_id, customer.id);
});

test("an old CRM's visits move into bookings once, with the quotes and invoices that named them", async (t) => {
  if (skip) return t.skip(skip);
  const { customer } = await createCustomer(db, { name: "Old Timer", email: "old@example.com", stage: "new", address: "1 Elm St" }, ME);
  const [{ id: booked }] = await db.sql<{ id: string }>`
    insert into bookings (starts_at, ends_at, name, email, location_kind) values (now(), now() + interval '1 hour', 'Old Timer', 'old@example.com', 'phone') returning id::text as id`;
  await db.transaction([
    q`create table customer_visits (id bigserial primary key, customer_id bigint not null, booking_id bigint, title text not null, status text not null,
        starts_at timestamptz, owner citext, amount_cents bigint, currency text, fields jsonb not null default '{}'::jsonb, notes text,
        created_by citext, updated_by citext, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`,
    q`insert into customer_visits (id, customer_id, booking_id, title, status, starts_at, owner, amount_cents, currency, notes) values
        (1, ${customer.id}::bigint, null, 'Furnace repair', 'done', '2026-05-01 15:00+00', 'Sam', 12900, 'USD', 'Replaced the igniter'),
        (2, ${customer.id}::bigint, ${booked}::bigint, 'Phone consult', 'done', null, null, 5000, 'USD', null)`,
  ]);
  await applySchema(db, readFileSync("test/fixtures/other-apps.sql", "utf8"));
  await applySchema(db, readFileSync("src/payments/schema.sql", "utf8"));
  await applySchema(db, readFileSync("src/invoices/schema.sql", "utf8"));
  const [{ id: quoteId }] = await db.sql<{ id: string }>`
    insert into quotes (number, email, currency, visit_id) values ('Q-OLD', 'old@example.com', 'usd', 1) returning id::text as id`;
  await moveVisits(db);
  assert.equal((await db.sql`select to_regclass('customer_visits') as t`)[0].t, null, "the old table is gone");
  const events = await customerEvents(db, customer.id);
  const repair = events.find((e) => e.what === "Furnace repair")!;
  assert.deepEqual([repair.status, repair.amount_cents, repair.notes, repair.host_name, repair.location], ["completed", "12900", "Replaced the igniter", "Sam", "1 Elm St"]);
  const consult = (await getEvent(db, booked))!;
  assert.deepEqual([consult.status, consult.amount_cents, consult.customer_id], ["completed", "5000", customer.id], "one made from a booking fills it in");
  assert.equal((await db.sql<{ v: string }>`select visit_id::text as v from quotes where id = ${quoteId}::bigint`)[0].v, repair.id, "the quote names its booking");
  await moveVisits(db); // no table: nothing happens
});

test("the customer list runs by last contact, one never contacted by when they were added", async (t) => {
  if (skip) return t.skip(skip);
  for (const n of [1, 2, 3]) await createCustomer(db, { name: `Order ${n}`, email: `order${n}@example.com`, stage: "new" }, ME);
  await db.sql`update customers set created_at = '2030-02-01', last_contact_at = '2030-02-05' where email = 'order1@example.com'`;
  await db.sql`update customers set created_at = '2030-02-03', last_contact_at = null where email = 'order2@example.com'`;
  await db.sql`update customers set created_at = '2030-01-01', last_contact_at = '2030-01-02', updated_at = '2031-01-01' where email = 'order3@example.com'`;
  const rows = await listPage(db, { ...NO_FILTER, q: "Order " }, null, 10);
  assert.deepEqual(rows.map((c) => c.name), ["Order 1", "Order 2", "Order 3"], "a recent edit does not move anyone up");
});

test("a team member written by name or by email is one person: shown by name, filtered either way", async (t) => {
  if (skip) return t.skip(skip);
  await applySchema(db, readFileSync("test/fixtures/other-apps.sql", "utf8"));
  await db.sql`insert into resources (name, email, time_zone) values ('Dee Ortiz', 'dee@team.example', 'UTC')`;
  await loadTeam(db);
  try {
    const a = (await createCustomer(db, { name: "Owner A", email: "owner-a@example.com", stage: "new", owner: "dee@team.example" }, ME)).customer;
    const b = (await createCustomer(db, { name: "Owner B", email: "owner-b@example.com", stage: "new", owner: "Dee Ortiz" }, ME)).customer;
    const found = await listPage(db, { ...NO_FILTER, q: "Owner ", owner: "Dee Ortiz" }, null, 10);
    assert.deepEqual(found.map((c) => c.id).sort(), [a.id, b.id].sort());
  } finally {
    setTeam([]);
  }
});

test("the morning email reaches a team member a task names by name, at the team list's email", async (t) => {
  if (skip) return t.skip(skip);
  await applySchema(db, readFileSync("test/fixtures/other-apps.sql", "utf8"));
  await db.sql`insert into resources (name, email, time_zone) values ('Mo Reyes', 'mo@team.example', 'UTC')`;
  const { customer } = await createCustomer(db, { name: "Name Owner", email: "name-owner@example.com", stage: "new" }, ME);
  await addTask(db, customer.id, { kind: "call", title: "Ring by name", due_on: "2031-03-03", due_time: null, owner: "Mo Reyes", deal_id: null }, ME);
  const sent: { to: string; text: string }[] = [];
  await sendDigests(db, async (m) => (sent.push(m), { status: "sent" as const, via: "fake" }), { timeZone: "UTC", now: new Date("2031-03-03T09:00:00Z") });
  assert.ok(sent.some((m) => m.to === "mo@team.example" && /Ring by name/.test(m.text)));
});

test("setup saves everyone already in the tables: by email, else by phone, never by name; spam and a row with neither are not", async (t) => {
  if (skip) return t.skip(skip);
  // Rows written before the skills saved people as they arrived (straight into the tables here).
  await db.sql`
    insert into submissions (form_key, name, email, phone, data, source, status) values
      ('quote', 'Rae Fox', 'rae@example.com', null, '{"address": "4 Elm St", "insurance": "delta dental"}', 'website', 'new'),
      ('quote', 'Rae F.', 'RAE@example.com', null, '{}', 'website', 'new'),
      ('quote', 'Sid Ng', null, '(555) 404-7171', '{}', 'website', 'new'),
      ('quote', 'Sidney', null, '+1 555 404 7171 ext 9', '{}', 'website', 'new'),
      ('quote', 'Nobody Known', null, null, '{}', 'website', 'new'),
      ('quote', 'Spam Guy', 'spamguy@example.com', null, '{}', 'website', 'spam')`;
  await publishFields(db, [{ key: "insurance", label: "Insurance", type: "select", options: ["Delta Dental", "Aetna"] }]);
  const first = (await firstOpenStage(db, "customers"))!;
  assert.ok((await saveEveryone(db)) >= 2);
  const rae = await rows("select name, address, fields, stage, created_by::text as by from customers where email = 'rae@example.com'");
  assert.deepEqual(rae, [{ name: "Rae Fox", address: "4 Elm St", fields: { insurance: "Delta Dental" }, stage: first.key, by: null }], "one Rae, from what she gave first, her custom field from her answer, by no one");
  const sid = await rows("select name from customers where right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = '5554047171'");
  assert.deepEqual(sid, [{ name: "Sid Ng" }], "the same phone written two ways is one person; the name never decides");
  assert.equal((await rows("select 1 from customers where name in ('Nobody Known', 'Spam Guy') or email = 'spamguy@example.com'")).length, 0);
  assert.equal(await saveEveryone(db), 0, "a second run saves no one");
  await publishFields(db, []);
});

test("converting a lead into another contact's deal (the form lets you switch) gives the call back to the deal's contact", async (t) => {
  if (skip) return t.skip(skip);
  const { customer: asker } = await createCustomer(db, { name: "Ask Er", email: "asker@example.com", stage: "new" }, ME);
  const { customer: payer } = await createCustomer(db, { name: "Pay Er", email: "payer@example.com", stage: "new" }, ME);
  const leadId = (await saveLead(db, { customerId: asker.id, source: "phone", title: "Quote for the rental" }, ME))!;
  const [deal] = await db.sql<{ id: string }>`insert into deals (customer_id, title, stage) values (${payer.id}::bigint, 'Rental unit', 'new') returning id::text as id`;
  assert.equal(await convertLead(db, leadId, deal.id, ME), true);
  assert.deepEqual(await db.sql`select customer_id::text as c, title, deal_id::text as d from follow_ups where deal_id = ${deal.id}::bigint`,
    [{ c: payer.id, title: "Call back Pay Er", d: deal.id }]);
});

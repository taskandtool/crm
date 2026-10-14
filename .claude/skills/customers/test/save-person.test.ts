import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applySchema } from "../../data/migrate";
import { scratch, why } from "../../data/test/scratch";
import { answerFields, phoneKey, savePerson } from "../customer";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const at = new Date("2026-10-14T15:00:00Z");

test("phoneKey: the last ten digits, an extension left off; under seven is no key", () => {
  assert.equal(phoneKey("(555) 404-7171"), "5554047171");
  assert.equal(phoneKey("+1 555 404 7171 ext 9"), "5554047171");
  assert.equal(phoneKey("12345"), null);
  assert.equal(phoneKey(null), null);
});

test("answerFields reads a form's answers as the CRM's form does, and leaves out what it would refuse", () => {
  const defs = [
    { key: "insurance", label: "Insurance", type: "select", options: ["Delta Dental", "Aetna"] },
    { key: "visit", label: "Visit", type: "date", options: [] },
    { key: "units", label: "Units", type: "number", options: [] },
  ];
  assert.deepEqual(answerFields(defs, { insurance: "delta dental", visit: "2026-11-02", units: "1,200", colour: "red" }), { insurance: "Delta Dental", visit: "2026-11-02", units: 1200 });
  assert.deepEqual(answerFields(defs, { insurance: "Cigna", visit: "next week", units: "lots" }), {});
});

test("savePerson: by email, else phone, never by name; one record for a double submit; blanks filled, nothing replaced", async (t) => {
  const s = await scratch();
  if (!s) return t.skip(why);
  try {
    await applySchema(s.db, schema);
    await s.db.sql`insert into customer_fields (key, label, type, options) values ('insurance', 'Insurance', 'select', '{Delta Dental,Aetna}')`;
    const count = async () => (await s.db.sql<{ n: number }>`select count(*)::int as n from customers`)[0].n;

    const rae = (await savePerson(s.db, { name: "Rae Fox", email: "Rae@Example.com", phone: null, source: "Get a quote", at, answers: { address: "4 Elm St", insurance: "aetna" } }, null))!;
    const [row] = await s.db.sql`select name, email::text as email, address, fields, stage, source, created_by, last_contact_at from customers where id = ${rae.id}::bigint`;
    assert.deepEqual({ ...row, last_contact_at: new Date(row.last_contact_at).toISOString() }, {
      name: "Rae Fox", email: "rae@example.com", address: "4 Elm St", fields: { insurance: "Aetna" }, stage: "lead", source: "Get a quote", created_by: null, last_contact_at: at.toISOString(),
    });
    // Her second form: the same record; her phone fills in, her address is not replaced, her name stays.
    const again = await savePerson(s.db, { name: "R. Fox", email: "rae@example.com", phone: "555 404 1111", source: "Booking: Estimate", at, answers: { address: "9 Other Rd" } }, null);
    assert.equal(again!.id, rae.id);
    const [after] = await s.db.sql`select name, phone, address from customers where id = ${rae.id}::bigint`;
    assert.deepEqual(after, { name: "Rae Fox", phone: "555 404 1111", address: "4 Elm St" });

    // The same phone written two ways, with no email: one person. The name never decides.
    const sid = await savePerson(s.db, { name: "Sid", email: null, phone: "(555) 404-7171", source: "Get a quote", at }, null);
    const sid2 = await savePerson(s.db, { name: "Someone Else", email: null, phone: "+1 555 404 7171 ext 9", source: "Get a quote", at }, null);
    assert.equal(sid2!.id, sid!.id);
    assert.equal(await savePerson(s.db, { name: "Sid", email: null, phone: null, source: "Get a quote", at }, null), null, "no email or phone: nothing to know them by");
    // Two emails on one household phone stay two people.
    const a = await savePerson(s.db, { name: "Pat", email: "pat@home.example", phone: "555 777 0000", source: "x", at }, null);
    const b = await savePerson(s.db, { name: "Lee", email: "lee@home.example", phone: "555 777 0000", source: "x", at }, null);
    assert.notEqual(a!.id, b!.id);

    // A merged record's old address finds the one it went into.
    await s.db.sql`insert into customers (name, email, stage, other_emails) values ('Cy', 'cy@new.example', 'lead', '{cy@old.example}')`;
    assert.equal((await savePerson(s.db, { name: "Cy", email: "cy@old.example", phone: null, source: "x", at }, null))!.name, "Cy");

    // A double submit at once makes one record, by email and by phone alone.
    const n = await count();
    await Promise.all([1, 2, 3].map(() => savePerson(s.db, { name: "Dot", email: "dot@example.com", phone: null, source: "x", at }, null)));
    await Promise.all([1, 2, 3].map(() => savePerson(s.db, { name: "Ed", email: null, phone: "555 909 0001", source: "x", at }, null)));
    assert.equal(await count(), n + 2);

    // With the CRM's statuses set up, a new customer starts in its first open one.
    await s.db.sql`create table pipeline_stages (key text primary key, label text not null, position integer not null default 0, kind text not null default 'open', archived boolean not null default false)`;
    await s.db.sql`insert into pipeline_stages (key, label, position, kind) values ('won', 'Won', 0, 'won'), ('enquiry', 'Enquiry', 1, 'open')`;
    assert.equal((await savePerson(s.db, { name: "Di", email: "di@example.com", phone: null, source: "x", at }, null))!.stage, "enquiry");
  } finally {
    await s.drop();
  }
});

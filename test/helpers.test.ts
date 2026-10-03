import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell } from "../src/admin/csv";
import type { CustomField } from "../src/config-schema";
import { decodeCsv, parseCsv, parseDate } from "../src/crm/csv-read";
import { readListCursor } from "../src/crm/customers";
import { localPath } from "../src/admin/query";
import { backTo } from "../src/app";
import { readFields } from "../src/crm/fields";
import { guessMap, planRows } from "../src/crm/importer";
import { makeInboxCursor, readInboxCursor, type InboxRow } from "../src/crm/inbox";
import { cleanPhone, phoneKey } from "../src/crm/phone";
import { amountText, parseAmount } from "../src/crm/visits";
import type { Stage } from "../src/crm/stages";
import { resolveStage } from "../src/crm/stages";
import { missingSentence } from "../src/crm/tables";
import { money, nowIn, parseTags, slugify, wallTime, wallToInstant } from "../src/crm/text";

const STAGES: Stage[] = [
  { key: "new", label: "New", position: 0, kind: "open", archived: false },
  { key: "won", label: "Won", position: 1, kind: "won", archived: false },
];
const FIELDS: CustomField[] = [
  { key: "truck", label: "Truck", type: "select", options: ["Truck 1", "Truck 2"] },
  { key: "age", label: "System age", type: "number" },
  { key: "due", label: "Next service", type: "date" },
  { key: "alt", label: "Other email", type: "email" },
];

test("a phone key is the last ten digits, and nothing under seven", () => {
  assert.equal(phoneKey("(555) 010-2030"), "5550102030");
  assert.equal(phoneKey("+1 555 010 2030"), "5550102030");
  assert.equal(phoneKey("+44 20 7946 0958"), phoneKey("020 7946 0958"));
  assert.equal(phoneKey("12-34"), null);
  assert.equal(phoneKey(undefined), null);
  assert.equal(cleanPhone("  555   0102 "), "555 0102");
  assert.equal(cleanPhone(""), null);
});

test("CSV: quotes, doubled quotes, newlines in quotes, BOM, CRLF, blank lines", () => {
  const rows = parseCsv('\uFEFFName,Notes\r\n"Lee, Ann","said ""hi""\nthen left"\r\n\r\nBob,\r\n');
  assert.deepEqual(rows, [["Name", "Notes"], ["Lee, Ann", 'said "hi"\nthen left'], ["Bob", ""]]);
});

test("dates from spreadsheets", () => {
  assert.equal(parseDate("2026-10-02"), "2026-10-02");
  assert.equal(parseDate("10/2/2026"), "2026-10-02");
  assert.equal(parseDate("25/12/26"), "2026-12-25");
  assert.equal(parseDate("2026-02-30"), null);
  assert.equal(parseDate("soon"), null);
});

test("the export defuses formulas in every form a spreadsheet runs", () => {
  assert.equal(csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
  for (const s of ["+1", "-1", "@SUM(A1)", " =1", "\t=1", "＝1"]) assert.ok(csvCell(s).replace(/^"/, "").startsWith("'"), s);
  assert.equal(csvCell("Ann"), "Ann");
});

test("custom fields are checked by type; empty clears; absent is left alone", () => {
  const r = readFields(FIELDS, { truck: "truck 2", age: "12", due: "2026-11-01", alt: "Bob@Example.com" });
  assert.deepEqual(r.set, { truck: "Truck 2", age: 12, due: "2026-11-01", alt: "bob@example.com" });
  assert.deepEqual(r.errors, []);
  const bad = readFields(FIELDS, { truck: "Truck 9", age: "old", due: "11/1/2026", alt: "nope" });
  assert.equal(bad.errors.length, 4);
  assert.deepEqual(bad.set, {});
  const loose = readFields(FIELDS, { truck: "Truck 9", due: "11/1/2026" }, { lenient: true });
  assert.deepEqual(loose.set, { truck: "Truck 9", due: "2026-11-01" });
  assert.equal(readFields(FIELDS, { age: "" }).unset[0], "age");
});

test("import mapping: headers by name, custom fields by key or label, first and last names joined", () => {
  const headers = ["First Name", "Last Name", "E-mail", "Mobile", "Company Name", "Lead Source", "Truck", "System age", "Status", "Unrelated"];
  const map = guessMap(headers, FIELDS);
  assert.equal(map.first_name, "First Name");
  assert.equal(map.last_name, "Last Name");
  assert.equal(map.email, "E-mail");
  assert.equal(map.phone, "Mobile");
  assert.equal(map.company, "Company Name");
  assert.equal(map.source, "Lead Source");
  assert.equal(map.truck, "Truck");
  assert.equal(map.age, "System age");
  assert.equal(map.stage, "Status");
  const plan = planRows(
    [headers, ["Ann", "Lee", " ANN@example.com ", "555 010 2030", "Lee Co", "Google", "truck 1", "12", "won", "x"], ["", "", "", "", "", "", "", "", "", "only junk"], ["Bo", "", "not-an-email", "", "", "", "", "", "Someday", ""]],
    map,
    FIELDS,
    STAGES,
  );
  assert.equal(plan.records.length, 2);
  assert.deepEqual(plan.skipped, [3]);
  assert.deepEqual([plan.records[1].name, plan.records[1].email, plan.records[1].stage], ["Bo", null, null]);
  const [r] = plan.records;
  assert.equal(r.name, "Ann Lee");
  assert.equal(r.email, "ann@example.com");
  assert.equal(r.stage, "won");
  assert.deepEqual(r.fields, { truck: "Truck 1", age: 12 });
  assert.ok(plan.warnings.some((w) => w.includes("Someday")));
  assert.ok(plan.warnings.some((w) => w.includes("not addresses")));
});

test("small text helpers", () => {
  assert.deepEqual(parseTags("VIP, vip; Roof ,, "), ["VIP", "Roof"]);
  assert.equal(slugify("Estimate sent!"), "estimate-sent");
  assert.equal(slugify("Café"), "cafe");
  assert.equal(slugify("!!!"), "stage");
  assert.equal(wallTime("2026-10-02T14:30"), "2026-10-02 14:30:00");
  assert.equal(wallTime("2026-10-02 14:30:15"), "2026-10-02 14:30:15");
  assert.equal(wallTime("tomorrow"), null);
  assert.equal(nowIn("America/Chicago", new Date("2026-10-02T05:30:00Z")), "2026-10-02T00:30");
  assert.equal(money(12345, "usd"), "$123.45");
  assert.equal(money(500, "jpy"), "¥500");
  assert.equal(resolveStage(STAGES, "WON")?.key, "won");
  assert.equal(resolveStage(STAGES, "new")?.key, "new");
});

test("the inbox cursor round-trips and refuses anything else", () => {
  const row = { kind: "booking", id: "42", k: "2026-10-02T10:00:00.123456Z" } as InboxRow;
  assert.deepEqual(readInboxCursor(makeInboxCursor(row)), { k: row.k, r: 1, id: "42" });
  assert.equal(readInboxCursor("garbage"), null);
  assert.equal(readInboxCursor(Buffer.from(JSON.stringify(["2026-10-02", 1, "1"])).toString("base64url")), null);
  assert.equal(readInboxCursor(Buffer.from(JSON.stringify([row.k, 7, "1"])).toString("base64url")), null);
});

test("one sentence for the tables a project lacks", () => {
  const none = { submissions: false, forms: false, bookings: false, resources: false, payments: false };
  assert.match(missingSentence(none, { submissions: true, bookings: true, payments: true })!, /no form submissions, bookings or payments yet/);
  assert.match(missingSentence({ ...none, submissions: true, forms: true }, { submissions: true, bookings: false, payments: true })!, /no payments yet/);
  assert.equal(missingSentence({ ...none, submissions: true, bookings: true, payments: true }, { submissions: true, bookings: true, payments: true }), null);
});

// Review regressions.

test("a phone key leaves an extension off, so the number still matches", () => {
  for (const v of ["555-010-2030 x12", "(555) 010-2030 ext. 12", "555.010.2030 ext 4", "555 010 2030 Extension 120", "555-010-2030#7", "+1 555 010 2030 x 99"]) {
    assert.equal(phoneKey(v), "5550102030", v);
  }
  assert.equal(phoneKey("010 2030 x5"), "0102030", "seven digits once the extension is off");
  assert.equal(phoneKey("2030 x123"), null, "an extension does not make a short number long enough");
  assert.equal(phoneKey(" ".repeat(50_000) + "x"), null, "long input is cut before the pattern runs");
});

test("CSV: semicolon and tab separators, and an unclosed quote is an error with its line", () => {
  assert.deepEqual(parseCsv("Name;Email\nAnn;ann@example.com\n"), [["Name", "Email"], ["Ann", "ann@example.com"]]);
  assert.deepEqual(parseCsv("Name\tEmail\nAnn\tann@example.com"), [["Name", "Email"], ["Ann", "ann@example.com"]]);
  assert.deepEqual(parseCsv('Name,Notes\nAnn,"a; b"\n'), [["Name", "Notes"], ["Ann", "a; b"]], "a comma header keeps semicolons as text");
  assert.throws(() => parseCsv('Name,Notes\nAnn,ok\nBob,"never closed\nCat,x\n'), /line 3/);
});

test("CSV bytes: UTF-8, UTF-16 with a BOM, and Windows-1252 from an old Excel", () => {
  const utf8 = new TextEncoder().encode("Name\nJosé\n");
  assert.deepEqual(decodeCsv(utf8), { text: "Name\nJosé\n", encoding: "utf-8" });
  const cp1252 = Uint8Array.from([...Buffer.from("Name\nJos", "latin1"), 0xe9, 0x0a]);
  assert.deepEqual(decodeCsv(cp1252), { text: "Name\nJosé\n", encoding: "windows-1252" });
  const quotes = Uint8Array.from([...Buffer.from("Ann O", "latin1"), 0x92, ...Buffer.from("Brien ", "latin1"), 0x80, 0x35, 0x0a]);
  assert.equal(decodeCsv(quotes).text, "Ann O\u2019Brien \u20ac5\n");
  const utf16 = Uint8Array.from([0xff, 0xfe, ...Buffer.from("Name\nJosé\n", "utf16le")]);
  assert.deepEqual(decodeCsv(utf16), { text: "Name\nJosé\n", encoding: "utf-16le" });
});

test("a wall time must be a real one", () => {
  assert.equal(wallTime("2026-02-30 10:00"), null);
  assert.equal(wallTime("2026-10-02 25:00"), null);
  assert.equal(wallTime("2026-13-01T10:00"), null);
  assert.equal(wallTime("2026-10-02 14:30:60"), null);
  assert.equal(wallTime("2028-02-29 09:05"), "2028-02-29 09:05:00");
});

test("list and inbox cursors refuse a time Postgres would choke on", () => {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  assert.deepEqual(readListCursor(enc(["2026-10-02T10:00:00.123456Z", "5"])), { k: "2026-10-02T10:00:00.123456Z", id: "5" });
  assert.equal(readListCursor(enc(["not a time", "5"])), null);
  assert.equal(readListCursor(enc(["2026-02-30T10:00:00.000000Z", "5"])), null);
  assert.equal(readInboxCursor(enc(["2026-02-30T10:00:00.000000Z", 1, "1"])), null);
});

test("a return path that resolves to another site goes home instead", () => {
  for (const p of ["/.//evil.example", "/..//evil.example/x", "/%2e//evil.example", "/a/..//evil.example"]) {
    const to = backTo(localPath(p, "", "/"), "done");
    assert.ok(!to.startsWith("//"), `${p} -> ${to}`);
    assert.equal(to, "/?saved=done");
  }
  assert.equal(backTo("/customers/4?x=1", "stage"), "/customers/4?x=1&saved=stage");
});

test("a wall time in a zone is the instant Postgres would give, across DST", () => {
  assert.equal(wallToInstant("2026-10-02 00:00:00", "America/Chicago").toISOString(), "2026-10-02T05:00:00.000Z");
  assert.equal(wallToInstant("2026-01-15 00:00:00", "America/Chicago").toISOString(), "2026-01-15T06:00:00.000Z");
  assert.equal(wallToInstant("2026-03-08 09:30:00", "America/Chicago").toISOString(), "2026-03-08T14:30:00.000Z");
  assert.equal(wallToInstant("2026-10-02 00:00:00", "UTC").toISOString(), "2026-10-02T00:00:00.000Z");
  assert.equal(wallToInstant("2026-10-02 00:00:00", "Asia/Kolkata").toISOString(), "2026-10-01T18:30:00.000Z");
});

test("amounts: minor units in the currency's own decimals, a comma only ever thousands", () => {
  assert.equal(parseAmount("1,245.50", "USD"), 124550);
  assert.equal(parseAmount("$90", "USD"), 9000);
  assert.equal(parseAmount(" 0.5 ", "USD"), 50);
  assert.equal(parseAmount("", "USD"), null);
  assert.equal(parseAmount("12,50", "EUR"), 125000, "a comma is a thousands separator, so 12,50 is 1250");
  assert.equal(parseAmount("1.005", "USD"), "invalid", "no fractions of a cent");
  assert.equal(parseAmount("-5", "USD"), "invalid");
  assert.equal(parseAmount("ten", "USD"), "invalid");
  assert.equal(parseAmount("£1,200", "GBP"), 120000);
  assert.equal(parseAmount("5000", "JPY"), 5000);
  assert.equal(parseAmount("50.5", "JPY"), "invalid");
  assert.equal(amountText("124550", "USD"), "1245.50");
  assert.equal(amountText(5, "USD"), "0.05");
  assert.equal(amountText(5000, "JPY"), "5000");
  assert.equal(amountText(null, "USD"), "");
});

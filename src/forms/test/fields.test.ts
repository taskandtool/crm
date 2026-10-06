import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFields, sitePath, validate, type Field } from "../fields";

const fields: Field[] = [
  { name: "name", label: "Name", type: "text", required: true },
  { name: "email", label: "Email", type: "email", required: true },
  { name: "phone", label: "Phone", type: "tel" },
  { name: "message", label: "Message", type: "textarea", maxLength: 20 },
  { name: "size", label: "Size", type: "select", options: ["Small", "Large"] },
  { name: "when", label: "When", type: "date" },
  { name: "budget", label: "Budget", type: "number" },
  { name: "how", label: "How", type: "radio", options: ["Phone", "Email"] },
  { name: "rooms", label: "Rooms", type: "checkbox", options: ["Kitchen", "Bath"] },
  { name: "urgent", label: "Urgent", type: "checkbox" },
  { name: "news", label: "Send me news", type: "consent" },
];

test("a good submission puts the person in columns and the rest in data", () => {
  const r = validate(fields, {
    name: " Ann Lee ",
    email: " Ann@Example.COM ",
    phone: "+1 (555) 010-2000",
    message: "Hello",
    size: "Large",
    when: "2026-02-28",
    budget: "1,200",
    how: "Email",
    rooms: ["Kitchen", "Bath", "Kitchen"],
    urgent: "yes",
    news: "yes",
    sneaky: "ignored",
  });
  assert.ok(r.ok);
  assert.equal(r.submission.name, "Ann Lee");
  assert.equal(r.submission.email, "ann@example.com");
  assert.equal(r.submission.phone, "+1 (555) 010-2000");
  assert.deepEqual(r.submission.data, {
    message: "Hello",
    size: "Large",
    when: "2026-02-28",
    budget: 1200,
    how: "Email",
    rooms: ["Kitchen", "Bath"],
    urgent: true,
    news: true,
    _consent: { news: "Send me news" },
  });
  assert.equal("sneaky" in r.submission.data, false);
});

test("every type refuses what it cannot hold", () => {
  const r = validate(fields, {
    name: "",
    email: "ann@example",
    phone: "call me",
    message: "x".repeat(21),
    size: "Huge",
    when: "2026-02-30",
    budget: "lots",
    how: "Post",
    rooms: ["Garage"],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.ok ? {} : r.errors).sort(), ["budget", "email", "how", "message", "name", "phone", "rooms", "size", "when"]);
  // what they typed comes back for the re-rendered form
  assert.equal(r.values.email, "ann@example");
  assert.deepEqual(r.values.rooms, ["Garage"]);
});

test("required boxes and choices must be answered; optional ones may be empty", () => {
  const f: Field[] = [
    { name: "terms", label: "I agree", type: "consent", required: true },
    { name: "pick", label: "Pick", type: "radio", options: ["A", "B"], required: true },
    { name: "extras", label: "Extras", type: "checkbox", options: ["A", "B"] },
  ];
  const bad = validate(f, {});
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.ok ? {} : bad.errors).sort(), ["pick", "terms"]);
  const ok = validate(f, { terms: "yes", pick: "A" });
  assert.ok(ok.ok);
  assert.deepEqual(ok.submission.data, { terms: true, pick: "A", extras: [], _consent: { terms: "I agree" } });
});

test("an answer over the default length for its type is refused", () => {
  const r = validate([{ name: "note", label: "Note", type: "text" }], { note: "x".repeat(201) });
  assert.equal(r.ok, false);
});

test("a field named email is normalised whatever its type", () => {
  const r = validate([{ name: "email", label: "Email", type: "text" }], { email: "BOB@X.IO" });
  assert.ok(r.ok);
  assert.equal(r.submission.email, "bob@x.io");
});

test("a definition is checked before it is saved or rendered", () => {
  const { fields: ok, problems } = checkFields([
    { name: "name", label: "Name", type: "text", required: true },
    { name: "Bad Name", label: "x", type: "text" },
    { name: "name", label: "Again", type: "text" },
    { name: "company_website", label: "Trap", type: "text" },
    { name: "size", label: "Size", type: "select", options: ["One"] },
    { name: "kind", label: "Kind", type: "nope" },
    { name: "note", label: "", type: "text" },
  ]);
  assert.deepEqual(ok.map((f) => f.name), ["name"]);
  assert.deepEqual(Object.keys(problems).sort(), ["1", "2", "3", "4", "5", "6"]);
  assert.deepEqual(checkFields("not a list"), { fields: [], problems: {} });
});

test("a redirect stays on this site", () => {
  assert.equal(sitePath("/thanks?x=1"), "/thanks?x=1");
  for (const bad of ["//evil.example", "/\\evil", "https://evil.example", "thanks", "/a b"]) assert.equal(sitePath(bad), null, bad);
});

test("only the input's own keys are answers: an inherited name is not one", () => {
  const input = Object.create({ note: "inherited" });
  const r = validate([{ name: "note", label: "Note", type: "text", required: true }], input);
  assert.equal(r.ok, false);
});

test("a field may not be named after a built-in every object has", () => {
  // NAME is lowercase only, so constructor and __proto__ are the ones that could match.
  const { fields: ok, problems } = checkFields([
    { name: "constructor", label: "C", type: "text" },
    { name: "kind", label: "K", type: "text" },
  ]);
  assert.deepEqual(ok.map((f) => f.name), ["kind"]);
  assert.match(problems["0"], /reserved/);
  // A row saved before this check still validates instead of throwing on Object's constructor.
  assert.ok(validate([{ name: "constructor", label: "C", type: "text" }], {}).ok);
});

test("control, bidi and invisible characters are cleaned before checking and storing", () => {
  const f: Field[] = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "company", label: "Company", type: "text" },
    { name: "message", label: "Message", type: "textarea" },
  ];
  const r = validate(f, {
    name: "Ann\u0000Lee\r\n\r\nOpen it: https://evil.example",
    company: "‮gnp.exe",
    message: "line one\r\nline two\u0000\u0007",
  });
  assert.ok(r.ok);
  assert.equal(r.submission.name, "Ann Lee Open it: https://evil.example");
  assert.equal(r.submission.data.company, "gnp.exe");
  assert.equal(r.submission.data.message, "line one\nline two");
  // Nothing but zero-width or bidi characters is no answer.
  const empty = validate(f, { name: "​‍﻿‮" });
  assert.equal(empty.ok, false);
});

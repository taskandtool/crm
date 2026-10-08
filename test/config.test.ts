import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { validate } from "../src/config-schema";
import { additiveProblems } from "../src/data/migrate";

// The config the CRM ships with; every test runs against it (pin-config.mjs).
const SHIPPED = "test/fixtures/crm.config.json";
const good = () => JSON.parse(readFileSync(SHIPPED, "utf8"));

test("the live config is valid", () => {
  assert.deepEqual(validate(JSON.parse(readFileSync("crm.config.json", "utf8"))), []);
});

test("the shipped config is valid and still to fill", () => {
  assert.deepEqual(validate(good()), []);
  // The "Shape the CRM" suggestion shows while the file says "to fill" anywhere.
  assert.ok(good().business.includes("to fill"));
  assert.equal(readFileSync(SHIPPED, "utf8").split("to fill").length, 2, "only the business line says to fill");
});

test("every example is valid, shaped, and the five businesses are there", () => {
  const files = readdirSync("examples").filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, ["counselor.json", "dental.json", "hvac.json", "plumbing-multi-location.json", "restaurant.json"]);
  for (const f of files) {
    const c = JSON.parse(readFileSync(`examples/${f}`, "utf8"));
    assert.deepEqual(validate(c), [], f);
    assert.ok(!c.business.includes("to fill"), `${f} has a business line`);
  }
  const plumbing = JSON.parse(readFileSync("examples/plumbing-multi-location.json", "utf8"));
  // A customer's location is theirs; which truck went is the job's.
  assert.equal(plumbing.fields[0].key, "location");
  assert.deepEqual(plumbing.visits.fields.map((f: { key: string }) => f.key).slice(0, 2), ["truck", "location"]);
  const counselor = JSON.parse(readFileSync("examples/counselor.json", "utf8"));
  assert.deepEqual(counselor.statuses.map((s: { label: string }) => s.label), ["New", "Contacted", "Current client", "Closed"]);
  assert.equal(counselor.deals.many, "Enquiries", "every CRM has a deal pipeline, named for the business");
  assert.equal(counselor.visits, false, "sessions are noted elsewhere");
  // A trade's pipeline is per job, so a returning customer gets a new one; their status says who they are.
  const hvac = JSON.parse(readFileSync("examples/hvac.json", "utf8"));
  assert.deepEqual(hvac.deals.stages.map((s: { label: string }) => s.label), ["New request", "Visit booked", "Estimate sent", "Job won", "Went elsewhere"]);
  assert.deepEqual(hvac.statuses.map((s: { kind: string }) => s.kind), ["open", "won", "won", "lost"]);
});

test("statuses and deal stages each need an open one, slug keys, no repeats and a known kind", () => {
  const c = good();
  c.statuses = [{ key: "won", label: "Won", kind: "won" }];
  c.deals.stages = [{ key: "lost", label: "Lost", kind: "lost" }];
  assert.ok(validate(c).some((p) => p.startsWith("statuses needs at least one open status")));
  assert.ok(validate(c).some((p) => p.startsWith("deals.stages needs at least one open stage")));
  const d = good();
  d.statuses.push({ key: "Big Deal", label: "x" }, { key: "lead", label: "again" }, { key: "maybe", label: "Maybe", kind: "perhaps" });
  const p = validate(d);
  assert.ok(p.some((x) => x.includes("must match")));
  assert.ok(p.some((x) => x.includes("repeats")));
  assert.ok(p.some((x) => x.includes("open, won or lost")));
  // The two lists are separate: a deal stage may share a status's key.
  const e = good();
  e.deals.stages.unshift({ key: "lead", label: "Lead", kind: "open" });
  assert.deepEqual(validate(e), []);
});

test("deals need words and stages; a currency and lost reasons when given; follow-ups an object", () => {
  const c = good();
  delete c.deals;
  assert.ok(validate(c).some((p) => p.startsWith("deals must be an object")));
  const d = good();
  d.deals = { one: "", many: "Deals", stages: [], currency: "dollars", lost_reasons: ["", 3] };
  const p = validate(d);
  assert.ok(p.some((x) => x.includes("deals needs one and many")));
  assert.ok(p.some((x) => x.includes("deals.stages must list")));
  assert.ok(p.some((x) => x.includes("deals.currency")));
  assert.ok(p.some((x) => x.includes("deals.lost_reasons")));
  const f = good();
  f.follow_ups = { new_lead: "yes" };
  assert.ok(validate(f).some((x) => x.includes("follow_ups must be an object")));
  delete f.follow_ups;
  assert.deepEqual(validate(f), [], "follow_ups is optional");
});

test("custom fields: known types, select options, no built-in or repeated keys", () => {
  const c = good();
  c.fields = [
    { key: "truck", label: "Truck", type: "select" },
    { key: "email", label: "Email again", type: "text" },
    { key: "size", label: "Size", type: "colour" },
    { key: "size", label: "Size", type: "text" },
    { key: "Bad-Key", label: "x", type: "text" },
  ];
  const p = validate(c);
  assert.ok(p.some((x) => x.includes("needs a list of options")));
  assert.ok(p.some((x) => x.includes("built-in")));
  assert.ok(p.some((x) => x.includes("type must be")));
  assert.ok(p.some((x) => x.includes("repeats")));
  assert.ok(p.some((x) => x.includes("lower case")));
});

test("visits: off, or words, their own fields and a currency", () => {
  const off = good();
  off.visits = false;
  assert.deepEqual(validate(off), []);
  delete off.visits;
  assert.deepEqual(validate(off), []);
  const c = good();
  c.visits = { one: "", many: "Jobs", fields: [{ key: "status", label: "Truck", type: "text" }, { key: "truck", label: "What", type: "text" }], currency: "usd" };
  const p = validate(c);
  assert.ok(p.some((x) => x.includes("visits needs one and many")));
  assert.ok(p.some((x) => x.includes("visits.fields[0].key status is a built-in")));
  assert.ok(p.some((x) => x.includes("visits.fields[1].label What is a built-in")));
  assert.ok(p.some((x) => x.includes("visits.currency")));
  const e = good();
  e.owner_label = "Technician";
  e.visits = { one: "Job", many: "Jobs", fields: [{ key: "tech", label: "Technician", type: "text" }, { key: "fee", label: "Amount (USD)", type: "number" }] };
  const pe = validate(e);
  assert.ok(pe.some((x) => x.includes("visits.fields[0].label Technician is a built-in")), "the owner's label heads a CSV column");
  assert.ok(pe.some((x) => x.includes("visits.fields[1].label Amount (USD) reads as a built-in")));
  const b = good();
  b.booking = "yes";
  b.booking_page = "acme.com/book";
  assert.ok(validate(b).some((x) => x.includes("booking must be true or false")));
  assert.ok(validate(b).some((x) => x.includes("booking_page must be")));
  const ok = good();
  ok.booking_page = "https://acme.com/book";
  assert.deepEqual(validate(ok), []);
  const d = good();
  d.visits = "yes";
  assert.ok(validate(d).some((x) => x.includes("visits must be false or an object")));
});

test("time zone and inbox rules are checked", () => {
  const c = good();
  c.time_zone = "Mars/Olympus";
  c.inbox = { forms: "some" };
  const p = validate(c);
  assert.ok(p.some((x) => x.includes("IANA")));
  assert.ok(p.some((x) => x.includes("inbox.forms")));
  const e = good();
  e.inbox = { forms: ["contact", "quote"], exclude_forms: ["newsletter"], bookings: false };
  assert.deepEqual(validate(e), []);
});

test("schema.sql only adds", () => {
  assert.deepEqual(additiveProblems(readFileSync("schema.sql", "utf8")), []);
  assert.deepEqual(additiveProblems(readFileSync("test/fixtures/other-apps.sql", "utf8")), []);
});

test("the manifest follows the platform's rules", () => {
  const m = JSON.parse(readFileSync("starter-app.json", "utf8"));
  assert.deepEqual(Object.keys(m).sort(), ["needs", "ready", "schema_version", "slug", "suggestions", "version"]);
  assert.equal(m.schema_version, 1);
  assert.equal(m.slug, "crm");
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(m.needs, { capabilities: [{ kind: "postgres", strength: "required" }] });
  assert.deepEqual(m.ready, { service: "web" });
  const ids = new Set<string>();
  for (const s of m.suggestions) {
    assert.match(s.id, /^[a-z0-9][a-z0-9_-]*$/);
    assert.ok(!ids.has(s.id));
    ids.add(s.id);
    assert.ok(s.label.length <= 48, s.label);
    assert.ok(s.prompt.length <= 1200, s.id);
    assert.ok(!/—/.test(s.label + s.prompt), "no em dashes");
  }
  assert.ok(m.suggestions.some((s: { when?: { path: string; is: string }[] }) => s.when?.some((w) => w.path === "crm.config.json" && w.is === "unfilled")));
});

test("time_zone is a zone name, never an offset Postgres reads backwards", () => {
  for (const tz of ["+05:00", "-03:00", "UTC+5", "GMT-3"]) {
    const c = good();
    c.time_zone = tz;
    assert.ok(validate(c).some((p) => p.includes("time_zone")), tz);
  }
  for (const tz of ["UTC", "America/Chicago", "Etc/GMT+5", "EST5EDT", "America/Port-au-Prince"]) {
    const c = good();
    c.time_zone = tz;
    assert.deepEqual(validate(c), [], tz);
  }
});

test("a custom field's label is not a built-in column's header, and labels do not repeat", () => {
  const c = good();
  c.fields = [{ key: "work_email", label: "Email", type: "email" }];
  assert.ok(validate(c).some((p) => p.includes("built-in column's name")));
  const d = good();
  d.fields = [{ key: "a", label: "Truck", type: "text" }, { key: "b", label: "truck", type: "text" }];
  assert.ok(validate(d).some((p) => p.includes("repeats")));
});

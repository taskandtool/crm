import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { validate } from "../src/config-schema";
import { additiveProblems } from "../src/data/migrate";

const good = () => JSON.parse(readFileSync("crm.config.json", "utf8"));

test("the shipped config is valid and still to fill", () => {
  assert.deepEqual(validate(good()), []);
  // The "Shape the CRM" suggestion shows while the file says "to fill" anywhere.
  assert.ok(good().business.includes("to fill"));
  assert.equal(readFileSync("crm.config.json", "utf8").split("to fill").length, 2, "only the business line says to fill");
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
  assert.deepEqual(plumbing.fields.filter((f: { type: string }) => f.type === "select").map((f: { key: string }) => f.key).slice(0, 2), ["location", "truck"]);
  const counselor = JSON.parse(readFileSync("examples/counselor.json", "utf8"));
  assert.deepEqual(counselor.stages.map((s: { label: string }) => s.label), ["New", "Contacted", "Closed"]);
  assert.equal(counselor.pipeline, false);
});

test("stages need an open one, slug keys, no repeats and a known kind", () => {
  const c = good();
  c.stages = [{ key: "won", label: "Won", kind: "won" }];
  assert.ok(validate(c).some((p) => p.includes("open stage")));
  const d = good();
  d.stages.push({ key: "Big Deal", label: "x" }, { key: "new", label: "again" }, { key: "maybe", label: "Maybe", kind: "perhaps" });
  const p = validate(d);
  assert.ok(p.some((x) => x.includes("must match")));
  assert.ok(p.some((x) => x.includes("repeats")));
  assert.ok(p.some((x) => x.includes("open, won or lost")));
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

test("time zone, views and inbox rules are checked", () => {
  const c = good();
  c.time_zone = "Mars/Olympus";
  c.default_view = "board";
  c.inbox = { forms: "some" };
  const p = validate(c);
  assert.ok(p.some((x) => x.includes("IANA")));
  assert.ok(p.some((x) => x.includes("default_view")));
  assert.ok(p.some((x) => x.includes("inbox.forms")));
  const d = good();
  d.default_view = "pipeline";
  d.pipeline = false;
  assert.ok(validate(d).some((x) => x.includes("pipeline is false")));
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

// node --test test/tropes.test.mjs (from the tropes folder)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check, findings, repeated, sectionsOf } from "../tropes.mjs";

const rules = (text, opts) => findings(text, opts).map((f) => f.rule);
const CLI = fileURLToPath(new URL("../tropes.mjs", import.meta.url));

test("clean copy passes", () => {
  assert.deepEqual(rules("Book a survey this week: we measure, quote and fit within ten days."), []);
});

test("negation pivot", () => {
  assert.ok(rules("It's not just a roof, it's peace of mind.").includes("negation-pivot"));
  assert.ok(rules("Our roofers are licensed, not cheap.").includes("negation-pivot"));
  assert.ok(rules("Don't just fix it, fix it for good.").includes("negation-pivot"));
});

test("refused phrases and the em dash", () => {
  const r = rules("Say goodbye to leaks — elevate your home.");
  assert.ok(r.includes("refused-phrase"));
  assert.ok(r.includes("em-dash"));
});

test("a promise of fit that names nothing", () => {
  for (const s of [
    "Project management, shaped to your work.",
    "A CRM shaped to how you work.",
    "Set it up your way.",
    "A view tailored to them.",
    "Pick the plan for how you work.",
    "Boards for the work your team really does.",
    "Built for scale.",
    "Guided walks, built around you.",
    "Start simple. Shape it to your business.",
    "Shaped to your trade",
  ]) assert.ok(rules(s).includes("vague-fit"), s);
  for (const s of [
    "Shape it by chat.",
    "Change the stages and fields to fit your business.",
    "On your way home, book a check.",
    "Built for roofers in Leeds.",
  ]) assert.ok(!rules(s).includes("vague-fit"), s);
});

test("an -ing rider", () => {
  assert.ok(rules("We rebuilt the porch in May, ensuring years of shelter.").includes("ing-rider"));
});

test("a rhetorical question, then its answer", () => {
  assert.ok(rules("Tired of leaks? We fix them fast.").includes("rhetorical-question"));
});

test("one triad is allowed, two are not", () => {
  assert.deepEqual(rules("We measure, quote and fit."), []);
  assert.ok(rules("Fast. Simple. Effective. Roofs, gutters, and skylights.").includes("triads"));
});

test("triads are counted per section, so a list of parts does not trip them", () => {
  const sections = [
    { heading: "Roofs", body: "We fit slate, tile and lead." },
    { heading: "Gutters", body: "We clear, mend and replace gutters." },
  ];
  assert.ok(!check(sections).some((f) => f.rule === "triads"));
});

test("dated vocabulary counts by density, not one word", () => {
  assert.ok(!rules("A meticulous fitter, booked a week ahead.").includes("dated-vocabulary"));
  assert.ok(rules("We delve into intricate, meticulous work.").includes("dated-vocabulary"));
});

test("'X, not Y.' is only a hint; 'It's not X, it's Y' is an error", () => {
  const level = (t, rule) => findings(t).find((f) => f.rule === rule)?.severity;
  assert.equal(level("Cash only, not cards.", "negation-pivot"), "hint");
  assert.equal(level("It's not just a roof, it's peace of mind.", "negation-pivot"), "error");
});

test("uniform sentence length", () => {
  const flat = "We fit new boilers in a day. We service old ones in an hour. We clear blocked drains on site. " +
    "We mend leaking taps for a fee. We test gas pipes once a year. We fit smart thermostats for you.";
  assert.ok(rules(flat).includes("uniform-length"));
  const varied = "Boilers. We fit new boilers in a day and take the old one away the same afternoon, at no charge. " +
    "We service old ones. Drains too. Taps. And gas pipes, tested once a year with a certificate for your landlord.";
  assert.ok(!rules(varied).includes("uniform-length"));
});

test("talking about itself: an error in an ad, a hint on a page", () => {
  const text = "We built our firm on our name. We are here for you.";
  assert.equal(findings(text, { kind: "ad" }).find((f) => f.rule === "we-over-you").severity, "error");
  assert.equal(findings(text).find((f) => f.rule === "we-over-you").severity, "hint");
});

test("personal attributes only in ads", () => {
  assert.ok(rules("Struggling with debt?", { kind: "ad" }).includes("personal-attribute"));
  assert.ok(!rules("Struggling with debt?", { kind: "post" }).includes("personal-attribute"));
});

test("weak calls to action, as a label or in a sentence", () => {
  for (const label of ["Learn more", "Get started →", "Submit", "Click here", "Sign up"]) {
    assert.deepEqual(rules(label), ["weak-cta"], label);
  }
  assert.ok(rules("Click here to see our prices.").includes("weak-cta"));
  assert.deepEqual(rules("Book a service"), []);
  assert.deepEqual(rules("Submit your meter reading by Friday and we credit it the same day."), []);
});

test("a line that only restates its heading", () => {
  assert.ok(rules("We do fast boiler repairs across Leeds.", { heading: "Fast boiler repairs in Leeds" }).includes("restates-heading"));
  assert.ok(!rules("Same-day visits from Headingley to Horsforth, £85 for the first hour.", { heading: "Fast boiler repairs in Leeds" }).includes("restates-heading"));
});

test("tells in a heading count too", () => {
  assert.ok(rules("Fitted in three days.", { heading: "Roofing, reimagined" }).includes("refused-phrase"));
});

test("the same four-word phrase on two sections", () => {
  const found = repeated([
    { heading: "Boilers", body: "Same two engineers since 2004 fit every boiler." },
    { heading: "Prices", body: "Fixed prices, and the same two engineers since 2004." },
    { heading: "Area", body: "Leeds and Bradford." },
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].match, "same two engineers since 2004");
  assert.deepEqual(found[0].sections, [0, 1]);
  assert.deepEqual(repeated([{ body: "one of the best in the city" }, { body: "one of the best in town" }]), []);
});

test("unsourced puffery is a hint; with a number it is fine", () => {
  const f = findings("A trusted, certified local firm.");
  assert.deepEqual(f.map((x) => [x.rule, x.severity]), [["puffery", "hint"]]);
  assert.deepEqual(rules("Gas Safe certified since 2004, register number 512345."), []);
});

test("markdown splits into sections at its headings, past the frontmatter", () => {
  const s = sectionsOf("---\nkind: ad\n---\nIntro line.\n\n## Prices\nFrom £85.\n");
  assert.deepEqual(s.map((x) => x.heading), ["", "Prices"]);
});

test("the command: --json, exit codes, --help", () => {
  const run = (input, ...args) => spawnSync(process.execPath, [CLI, ...args, "-"], { input, encoding: "utf8" });
  const bad = run("Say goodbye to leaks.", "--json");
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout)[0].rule, "refused-phrase");
  assert.equal(run("A trusted firm.").status, 0);
  assert.equal(run("Fitted in three days.").stdout.trim(), "tropes: clean");
  for (const h of ["--help", "-h"]) assert.match(spawnSync(process.execPath, [CLI, h], { encoding: "utf8" }).stdout, /--kind/);
  for (const args of [["--kind", "x", "-"], ["--bogus", "-"], ["a.md", "b.md"], ["no-such-file.md"], []]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^tropes: .*\n {2}Try: /);
  }
});

test("the command: the count first, errors before hints, the first 40 and how to see the rest", () => {
  const many = Array.from({ length: 60 }, (_, i) => `# Part ${i}\nOur seamless service number ${i} ran fine in May.`).join("\n");
  const r = spawnSync(process.execPath, [CLI, "-"], { input: many, encoding: "utf8" });
  assert.equal(r.status, 1);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^tropes: \d+ errors, \d+ hints?\. Rewrite each flagged line whole\.$/);
  assert.equal(lines.filter((l) => /^ {2}(error|hint)/.test(l)).length, 40);
  assert.match(lines.at(-1), /^ {2}40 of \d+ shown; --json for all$/);
  assert.ok(lines.findIndex((l) => l.startsWith("  hint")) === -1 || lines.findIndex((l) => l.startsWith("  hint")) > lines.findLastIndex((l) => l.startsWith("  error")));
});

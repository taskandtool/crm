// node --test test/tropes.test.mjs (from the tropes folder)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check, findings, repeated, scan, sectionsOf, wordsOf } from "../tropes.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rules = (text, opts) => findings(text, opts).map((f) => f.rule);
const CLI = fileURLToPath(new URL("../tropes.mjs", import.meta.url));

test("clean copy passes", () => {
  assert.deepEqual(rules("Book a survey this week: we measure, quote and fit within ten days."), []);
});

test("a heading of fragments joined by a colon or a comma; a list's commas, numbers and times are fine", () => {
  for (const h of ["Fall cleanup in Larkfield, from $90.", "Fall cleanup in Larkfield,from $90.", "What we do, and what it costs", "Garden design: a plan in a week, planted in spring.", "Spring planting, Elm Street", "Send a proposal that wins the job, or just an invoice."]) {
    assert.ok(rules("A line under it.", { heading: h }).includes("joined-heading"), h);
  }
  for (const h of ["Fall cleanup in Larkfield starts at $90.", "Forms, bookings and payments on the site.", "Garden design, lawn, hedge and seasonal care", "1,412 visitors in October", "Open from 8:00 AM"]) {
    assert.ok(!rules("A line under it.", { heading: h }).includes("joined-heading"), h);
  }
});

test("negation pivot", () => {
  assert.ok(rules("It's not just a roof, it's peace of mind.").includes("negation-pivot"));
  assert.ok(rules("Our roofers are licensed, not cheap.").includes("negation-tail"));
  assert.ok(rules("This isn't about software. It's about your time.").includes("negation-pivot"));
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

test("a 'with' rider bolted onto a finished sentence", () => {
  assert.ok(rules("Your site runs on our servers, with its SEO and design done for you.").includes("with-rider"));
  assert.ok(!rules("Fall cleanup with leaf removal starts at $90.").includes("with-rider"));
});

test("today's models' figures of speech, and the literal uses that pass", () => {
  for (const s of ["Form requests land here as they come in.", "New deals land in the first stage.", "The quote landed.",
    "That matters.", "Why this matters to your crew", "Not a template. A real site you own.", "It's worth mentioning the warranty."]) {
    assert.ok(rules(s).some((r) => r === "model-tell" || r === "negation-pivot"), s);
  }
  for (const s of ["The plane lands at Logan at 9 AM.", "Read our landing page guide.", "Land more clients this spring.",
    "This matters when the ground is frozen.", "Our heat pumps run quietly.", "It's not working? Call us."]) {
    assert.ok(!findings(s).some((f) => f.severity === "error" && (f.rule === "model-tell" || f.rule === "negation-pivot")), s);
  }
  assert.equal(findings("Honestly, we love this job.").find((f) => f.rule === "model-tell").severity, "hint");
});

test("every figurative land, and the literal ones that pass", () => {
  for (const s of ["Your invoice lands in your inbox in seconds.", "The report lands every Monday morning.", "When a new lead lands, you get a text.",
    "Every booking lands straight in the CRM.", "Replies land in Messages.", "That line really landed."]) {
    assert.ok(rules(s).includes("model-tell"), s);
  }
  for (const s of ["The plane lands at Logan at 9 AM.", "We landed a new client in March.", "Check the landed cost before you order.",
    "We clear land in Larkfield.", "Read our landing page guide."]) {
    assert.ok(!rules(s).includes("model-tell"), s);
  }
});

test("the staged reveal, the crowned point and the handed-over brief", () => {
  for (const s of ["Here's the real issue: nobody follows up.", "Here's the kicker: it's free.", "The real problem is follow-up.",
    "That's the whole point.", "Then it hands you a short brief.", "Your data stays yours.", "At its core, it's a calendar.",
    "This is where the AI comes in.", "Because it matters."]) {
    assert.ok(rules(s).includes("model-tell"), s);
  }
  assert.ok(!rules("Back up anything that matters.").includes("model-tell"));
});

test("one staccato run is enough", () => {
  assert.ok(rules("No contracts. No setup fees. Just results.").includes("triads"));
});

test("text a line at a time: today's tells only", () => {
  const app = (s) => findings(s, { kind: "text" }).map((f) => f.rule);
  assert.deepEqual(app("Learn more about two-factor sign-in.\nWelcome to the team.\nUse a trusted device."), []);
  assert.deepEqual(app("New requests land here.\nSaved — reload to see it."), ["model-tell", "em-dash"]);
});

test("a long heading and a long hero are hints", () => {
  const lede = "Your site loads fast and stays up while the AI checks it every Monday for broken links and slow images and then fixes whatever it found as soon as you ask it to.";
  const found = check([{ heading: "A website you change by asking that the AI checks every single week for you", body: `${lede}\nStart your site` }]);
  assert.deepEqual(found.filter((f) => f.rule.startsWith("long-")).map((f) => [f.rule, f.severity]), [["long-heading", "hint"], ["long-hero", "hint"]]);
  assert.ok(!check([{ heading: "A website you change by asking.", body: "The AI builds the pages and checks them every week.\nStart your site" }]).some((f) => f.rule.startsWith("long-")));
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

test("'X, not Y' is an error in a heading or with 'not just', a hint in a sentence, and left alone a line at a time", () => {
  const level = (t, rule, kind) => findings(t, { kind }).find((f) => f.rule === rule)?.severity;
  const heading = (t) => check([{ heading: t, body: "Booking opens at 9 AM." }]).find((f) => f.rule === "negation-tail")?.severity;
  assert.equal(heading("Fill your chairs, not your phone"), "error");
  assert.equal(level("Clients book online, not just by phone.", "negation-tail"), "error");
  assert.equal(level("Cash only, not cards.", "negation-tail"), "hint");
  assert.equal(level("It's not just a roof, it's peace of mind.", "negation-pivot"), "error");
  assert.equal(level("Reply to the topic, not any specific post", "negation-tail", "text"), undefined);
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

test("--scan reads every line of code, comments and skills, and a sentence wrapped across two", () => {
  const dir = mkdtempSync(join(tmpdir(), "tropes-scan-"));
  mkdirSync(join(dir, "lib"));
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "lib", "jobs.ex"), '# A run that lands on a sleeping machine waits.\ndef label, do: "Saved"\n# This isn\'t about speed.\n# It\'s about order.\n');
  writeFileSync(join(dir, "lib", "SKILL.md"), 'Bad: "It\'s not a CRM, it\'s a team." <!-- tropes-allow -->\n');
  writeFileSync(join(dir, "node_modules", "x.js"), "// the update lands here\n");
  writeFileSync(join(dir, "lib", "notes.md"), '> "Came out on Christmas Eve — no extra charge." Priya\nShe said "it all lands on time — every week".\n');
  const found = scan([dir]).map((f) => [f.file.slice(dir.length + 1), f.line, f.rule]);
  assert.deepEqual(found, [["lib/jobs.ex", 1, "model-tell"], ["lib/jobs.ex", 3, "negation-pivot"]]);
  const r = spawnSync(process.execPath, [CLI, "--scan", dir], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^tropes: 2 findings in 1 file\./);
  assert.match(r.stdout, /lib\/jobs\.ex:1  model-tell  "lands"/);
  assert.match(r.stdout, /Fixes:\n  model-tell: /);
});

test("--words: a page's words as markdown, without the navigation or the pictures", () => {
  const html = `<html><body><nav><a href="/">Home</a></nav><main>
    <section><h1>Fall cleanup in Larkfield starts at $90.</h1><p>We clear the leaves &amp; cut the beds back.</p>
    <a class="btn btn-primary" href="/book">Book a visit</a>
    <div role="img" aria-label="a garden"><p>Mon 12 Oct</p><div>inner</div></div>
    <ul><li>Lawns</li><li>Hedges</li></ul></section></main><footer>© 2026</footer></body></html>`;
  assert.equal(wordsOf(html), "# Fall cleanup in Larkfield starts at $90.\n\nWe clear the leaves & cut the beds back.\n[Book a visit]\n\n- Lawns\n- Hedges\n");
});

test("the skills around this one carry no tells of their own", () => {
  const skills = fileURLToPath(new URL("../..", import.meta.url));
  const found = scan([skills]).map((f) => `${f.file.slice(skills.length)}:${f.line} ${f.rule} "${f.match}"`);
  assert.deepEqual(found, []);
});

test("a business's plain sentences pass, and the tells in curly quotes are caught", () => {
  const errors = (s) => findings(s).filter((f) => f.severity === "error" && !["weak-cta", "we-over-you"].includes(f.rule)).map((f) => f.rule);
  for (const s of ["If it isn't working, it's probably the battery.", "If this isn't your first visit, it's quicker to sign in.",
    "Cash only, not cards.", "Our ferry lands at the pier at 9.", "Fresh fish, landed this morning in Newlyn.",
    "Your flight will land at Heathrow.", "She landed a big contract.", "We disinfect surfaces every visit.",
    "Our valet hands you the keys.", "We do the heavy lifting for you on moving day.", "North Star Plumbing",
    "We pressure-test every gas line.", "A pharmacy that compounds custom medications.", "Lean into the stretch.",
    "Read the whole story.", "Licensed. Bonded. Insured.", "Dr. Ana Ruiz. Dr. Ben Cole. Dr. Kim Park."]) {
    assert.deepEqual(errors(s), [], s);
  }
  for (const s of ["It’s not a CRM, it’s your whole business.", "This isn’t about software. It’s about your time.",
    "Here’s where it gets interesting.", "No fluff. No filler.", "No contracts. No setup fees. Just results."]) {
    assert.ok(errors(s).length, s);
  }
  assert.deepEqual(findings('if job.state == :landed do\n["queued", "landed"]', { kind: "text" }), []);
});

test("--words keeps a hero outside <main> and a header inside it, and leaves out what is hidden", () => {
  const html = `<body><header><a href="/">Logo</a></header><section><h1>Hero line.</h1></section><main>
    <header><h2>A quote for Sam</h2></header><img src="a.png" aria-hidden="true" alt=""><p>Paragraph <b>one</b>, here.</p>
    <div class="hidden md:block">desk</div><div hidden>modal</div><a href="/x"><h3>Lawn care</h3><p>Weekly</p></a></main><footer>© 2026</footer></body>`;
  assert.equal(wordsOf(html), "# Hero line.\n\n## A quote for Sam\n\nParagraph one, here.\n\n### Lawn care\n\nWeekly\n");
});

test("--scan lets an em dash be in a code file's comments and docs, not in its strings", () => {
  const dir = mkdtempSync(join(tmpdir(), "tropes-comments-"));
  writeFileSync(join(dir, "a.ex"), [
    '# A backup runs nightly — the old one is kept.',
    '@moduledoc """',
    'One app — its machine and its code.',
    '"""',
    'def note, do: "Saved — reload to see it."',
    '<%!-- the hero — first screen --%>',
    '# The new request lands here.',
  ].join("\n"));
  writeFileSync(join(dir, "b.md"), "A backup runs nightly — the old one is kept.\n");
  const found = scan([dir]).map((f) => [f.file.slice(dir.length + 1), f.line, f.rule]);
  assert.deepEqual(found, [["a.ex", 5, "em-dash"], ["a.ex", 7, "model-tell"], ["b.md", 1, "em-dash"]]);
});

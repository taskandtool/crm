// node --test test/tropes.test.mjs (from the tropes folder)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check, findings, scan, sectionsOf, series, wordsOf } from "../tropes.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rules = (text, opts) => findings(text, opts).map((f) => f.rule);
const CLI = fileURLToPath(new URL("../tropes.mjs", import.meta.url));

test("clean copy passes", () => {
  assert.deepEqual(rules("Book a survey this week: we measure, quote and fit within ten days."), []);
});

test("negation pivot", () => {
  assert.ok(rules("It's not just a roof, it's peace of mind.").includes("negation-pivot"));
  assert.ok(rules("Our roofers are licensed, not cheap.").includes("negation-tail"));
  assert.ok(rules("This isn't about software. It's about your time.").includes("negation-pivot"));
  assert.ok(rules("Don't just fix it, fix it for good.").includes("negation-pivot"));
});

test("the em dash", () => {
  assert.ok(rules("We fit boilers — and service them.").includes("em-dash"));
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

test("the claudisms people rarely write, and the plain sentences that share their words", () => {
  for (const s of ["I keep coming back to one question.", "It all turns on trust.", "Here's where I landed.", "That's the throughline.",
  ]) {
    assert.ok(rules(s).includes("model-tell"), s);
  }
  for (const s of ["Customers keep coming back to us every spring.", "The heating turns on at 6 AM.", "North Star Plumbing fits boilers.",
    "Double-click on the file to open it.", "We pressure-test every gas line."]) {
    assert.ok(!rules(s).includes("model-tell"), s);
  }
  assert.equal(findings("Key takeaways from the survey are below.").find((f) => f.rule === "model-tell").severity, "hint");
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

test("one triad is allowed, two are not", () => {
  assert.deepEqual(rules("We measure, quote and fit."), []);
  assert.ok(rules("Fast. Simple. Effective. Roofs, gutters, and skylights.").includes("triads"));
});

test("a series is a short list with and or or, or a chain of clauses with the serial comma", () => {
  assert.equal(series("Start from a website, CRM or project board.").length, 1);
  assert.equal(series("We work at home, at the office or on the road.").length, 1);
  assert.equal(series("Ask for a change, check it in a working copy, and publish it when it's right.").length, 1);
  for (const s of ["When a client leaves, they take their code and data.", "If it rains, we reschedule, and you pay nothing.",
    "Hi, I'm Dana, and I run the shop.", "It changes when you ask, in your colors and fonts.", "Once it's published, people use it around the clock and none of that counts."]) {
    assert.deepEqual(series(s), [], s);
  }
});

test("two lists of three in the hero are a hint; elsewhere nothing", () => {
  const body = "Start from a website, CRM or project board. Ask for a change, check it in a working copy, and publish it.";
  const hero = check([{ heading: "Apps you change by asking.", body }]).filter((f) => f.rule === "triads");
  assert.deepEqual(hero.map((f) => f.severity), ["hint"]);
  const later = check([{ heading: "Apps you change by asking.", body: "Book a visit." }, { heading: "How it works", body }]).filter((f) => f.rule === "triads");
  assert.deepEqual(later, []);
});
test("triads are counted per section, so a list of parts does not trip them", () => {
  const sections = [
    { heading: "Roofs", body: "We fit slate, tile and lead." },
    { heading: "Gutters", body: "We clear, mend and replace gutters." },
  ];
  assert.ok(!check(sections).some((f) => f.rule === "triads"));
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

test("personal attributes only in ads", () => {
  assert.ok(rules("Struggling with debt?", { kind: "ad" }).includes("personal-attribute"));
  assert.ok(!rules("Struggling with debt?", { kind: "post" }).includes("personal-attribute"));
});

test("tells in a heading count too", () => {
  assert.ok(rules("Fitted in three days.", { heading: "Your quote lands in a day" }).includes("model-tell"));
});

test("markdown splits into sections at its headings, past the frontmatter", () => {
  const s = sectionsOf("---\nkind: ad\n---\nIntro line.\n\n## Prices\nFrom £85.\n");
  assert.deepEqual(s.map((x) => x.heading), ["", "Prices"]);
});

test("the command: --json, exit codes, --help", () => {
  const run = (input, ...args) => spawnSync(process.execPath, [CLI, ...args, "-"], { input, encoding: "utf8" });
  const bad = run("Your quote lands in a day.", "--json");
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout)[0].rule, "model-tell");
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
  const many = Array.from({ length: 60 }, (_, i) => `# Part ${i}\nThe report for job ${i} lands in May.`).join("\n");
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
  const errors = (s) => findings(s).filter((f) => f.severity === "error").map((f) => f.rule);
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
  assert.deepEqual(findings('if job.state == :landed do\n["queued", "landed"]\nlanded = visit(hook)\ncheck(code?(landed, "/x"), "#{landed.status}")', { kind: "text" }), []);
  assert.ok(rules("The quote landed. Then the next one landed, too.").includes("model-tell"));
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

test("--words reads a '>' inside an attribute as part of the tag, and keeps the space before '.zip'", () => {
  const html = `<body><main><ul class="[&_article>img]:size-9"><li>Start from a repo or a .zip.</li></ul></main></body>`;
  assert.equal(wordsOf(html), "- Start from a repo or a .zip.\n");
});

test("--words: an apostrophe in a script does not swallow the page", () => {
  const html = `<body><main><script>if (a<b) { /* it's */ }</script><p>Book a visit.</p><p>Call us.</p></main></body>`;
  assert.equal(wordsOf(html), "Book a visit.\n\nCall us.\n");
});

test("an order joined to a vague result is an error on a page", () => {
  for (const s of ["Send it a price list and the site uses it.", "Save the brand once and every page uses it.",
    "Change a price in the Brain, and the next page or post they write uses the new one."]) {
    assert.ok(rules(s).includes("order-result"), s);
  }
  assert.ok(!rules("Upload a price list in the chat. The AI adds the prices to your site.").includes("order-result"));
  assert.ok(!rules("Remove one, and the app can't use it anymore.").includes("order-result"));
  assert.ok(!findings("Send it a price list and the site uses it.", { kind: "text" }).some((f) => f.rule === "order-result"));
});

test("'once' as a promise of no effort is an error; a literal once is not", () => {
  for (const s of ["Ask once, and it runs every Monday.", "When Ana's season ends, remove her once.", "Change a fact once and your apps follow."]) {
    assert.ok(rules(s).includes("effort-once"), s);
  }
  for (const s of ["It checks the notes once a week.", "Upgrades take effect at once.", "We send your share once it reaches $50.", "A person listed twice comes in once."]) {
    assert.ok(!rules(s).includes("effort-once"), s);
  }
});


test("today's other shapes: 'no X, just Y' and how they actually run; 'at once' is literal", () => {
  assert.ok(rules("There's no lecture, just good care.").includes("negation-pivot"));
  assert.ok(rules("Built for how restaurants actually run").includes("vague-fit"));
  assert.ok(!rules("Do both at once:").includes("effort-once"));
});

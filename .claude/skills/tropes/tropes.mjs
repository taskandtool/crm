#!/usr/bin/env node
// The copy tells a pattern can find: the phrases, shapes and rhythms that make
// text read as generated. Node, no dependencies; the tropes skill says how to
// fix a finding. The word lists date: re-check them every six months.
//
//   import { findings, check } from "./tropes.mjs";
//   findings(text, { kind, heading })   one section's copy  → [{ rule, match, fix, severity }]
//   check(sections, { kind })           [{ heading, body }] → the same, each with `section`,
//                                       plus what only shows across sections
//
// kind: "page" (default), "post", or "ad" (adds Meta's personal-attribute rule
// and holds the copy to the reader, not the business). severity: "error" is a
// line to rewrite; "hint" is worth a look and never fails.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── the lists ─────────────────────────────────────────────────────────────
const PHRASES = [
  // openers and sweeps
  /\bin today'?s (fast-paced|digital|competitive|ever-changing) world\b/gi, /\bin a world where\b/gi,
  /\bimagine a world\b/gi, /\bwelcome to (our|my|the)\b/gi, /\bare you looking for\b/gi, /\bwhen it comes to\b/gi,
  /\bwhether you'?re\b/gi, /\blook no further\b/gi, /\bsomething for everyone\b/gi,
  // fake-casual reveals
  /\bhere'?s the thing\b/gi, /\band honestly\?/gi, /\byou know what'?s wild\b/gi, /\bthat changes everything\b/gi,
  /\bhere'?s what nobody\b/gi, /\blet'?s dive in\b/gi, /\bthat'?s where \w+ comes? in\b/gi,
  // ad cliches
  /\bsay goodbye to\b/gi, /\bto the next level\b/gi, /\bgame-?chang(er|ing)\b/gi, /\ball-in-one\b/gi,
  /\beverything you need\b/gi, /\bwhere \w+ meets \w+\b/gi, /\b\w+, (reimagined|redefined)\b/gi,
  // verb cosplay and inflated adjectives
  /\b(unlock|unleash|elevate|empower|revolutioni[sz]e|supercharge|transform) your\b/gi, /\bleverag(e|es|ed|ing)\b/gi,
  /\bseamless(ly)?\b/gi, /\beffortless(ly)?\b/gi, /\bcutting-edge\b/gi, /\bstate-of-the-art\b/gi, /\bgroundbreaking\b/gi,
  /\bworld-class\b/gi, /\bnext-level\b/gi, /\brobust\b/gi, /\bholistic\b/gi, /\bbespoke\b/gi,
  // significance inflation and brochure puffery
  /\bstands? as a testament\b/gi, /\bis a testament to\b/gi, /\bplays? an? (crucial|pivotal|vital|key) role\b/gi,
  /\bevolving landscape\b/gi, /\bnestled\b/gi, /\bin the heart of\b/gi, /\brich heritage\b/gi, /\bdiverse array\b/gi,
  /\b(tapestry|realm|ecosystem)\b/gi,
  // copula avoidance, hedges, closers, vague attribution
  /\bserves as\b/gi, /\bstands as\b/gi, /\bfunctions as\b/gi, /\bboasts\b/gi, /\bmore than just\b/gi,
  /\bit'?s worth noting\b/gi, /\bit'?s important to note\b/gi, /\bit goes without saying\b/gi, /\bin conclusion\b/gi,
  /\bultimately,/gi, /\b(industry reports|experts agree|studies show)\b/gi,
  // small-business cliches
  /\bwe'?re passionate about\b/gi, /\bwe pride ourselves\b/gi, /\bwe do things differently\b/gi,
  /\byour (trusted )?partner in\b/gi, /\bwe believe\b/gi,
];

const NEGATION = [
  /\bit'?s not (just )?(about )?[^.;:!?\n]{1,40}[,.;:] it'?s\b/gi,
  /\bnot (just|only|merely) [^.;:!?\n]{1,40},? but\b/gi,
  /\bnot because [^.;:!?\n]{1,60}[.;,] because\b/gi,
  /\bdon'?t just \w+(?: \w+)?, \w+/gi,
];
// "Cash only, not cards." is often a plain fact, so this shape is only a hint
const NEGATION_TAIL = /\b\w+(?: \w+)?, not \w+(?: \w+)?[.!]/gi;

// A promise of fit that names nothing: what is shaped, to what? "Shape it by
// chat" names an action and passes.
const VAGUE_FIT = [
  /\b(shaped|tailored|built|designed|made|crafted) (to|around|for) (you|them|your (work|way|needs|business|team|company|trade|process))\b/gi,
  /\b(shape|tailor) (it|them) (to|around) (you|your)\b/gi,
  /\b(for|to|around|fits?|match(es)?) (how|the way) (you|your (team|business|company)) (really |actually )?(work|works|run|runs|do business)\b/gi,
  /(?<!\b(on|in|out of) )\byour way\b/gi,
  /\bthe work (you|your \w+) (really|actually) do(es)?\b/gi,
  /\bbuilt (for (scale|growth|the future|tomorrow|what comes next)|to (last|scale))\b/gi,
];

const ING_RIDER = /, (highlighting|ensuring|fostering|showcasing|reflecting|contributing to|underscoring|emphasizing|enhancing)\b/gi;

// Meta refuses copy that asserts or implies the reader's personal attributes.
const PERSONAL_ATTRIBUTES = [
  /\b(struggling|suffering) with\b/i, /\bdo you have (diabetes|anxiety|depression|debt|acne)\b/i,
  /\byour (weight|debt|depression|anxiety|diabetes|condition|diagnosis|credit score)\b/i,
  /\bare you (overweight|bankrupt|depressed|in debt|pregnant)\b/i,
];

const ERA_WORDS = /\b(delve|intricate|meticulous|testament|garnered|align with|enhance|fostering|showcasing|highlighting|bolstered|emphasizing|underscores?|pivotal|vibrant|interplay)\b/gi;

// A label that names the mechanism, not what the reader gets.
const WEAK_CTA = /^(submit|click here|learn more|read more|find out more|see more|get started|sign up|explore|discover)$/i;
const WEAK_CTA_IN_TEXT = /\b(click here|learn more|read more|find out more)\b/gi;

// Praise anyone can claim; fine with a number or a source beside it.
const PUFFERY = /\b(certified|honest|quality|trusted|premier|top-rated|reliable|professional|leading)\b/gi;

const STOP = new Set(("a an and are as at be by for from has have i in is it its of on or our so that the their them they this to up us we with you your " +
  "will can do does all any not no just more most than then there here what when who how if into out about over only also one best every each other some very own way like get").split(" "));

const FIX = {
  "em-dash": "a comma, a colon or a new sentence",
  "refused-phrase": "say the specific thing it stands in for, or cut it",
  "negation-pivot": "state the claim; nobody proposed the other",
  "vague-fit": "name what changes to fit: the stages, the fields, the hours, the price",
  "ing-rider": "cut the clause, or make it a sentence with a subject",
  "rhetorical-question": "say the answer as a statement",
  triads: "a rhythm of threes reads as generated: keep a real list of three, rewrite three-beat phrasing to the number of things there are",
  "dated-vocabulary": "the plain word; these date the copy to a model generation",
  "uniform-length": "mix short sentences with long ones",
  "we-over-you": "write about what the reader gets; at least as much you as we",
  "personal-attribute": "speak about the offer, not the reader's condition (Meta refuses it)",
  "weak-cta": 'name what the reader gets: "Book a survey", "Check availability"',
  "restates-heading": "the line under a heading adds a fact the heading did not say",
  "repeated-phrase": "say it once, where it matters most",
  puffery: "a number, a name or a source beside it, or cut it",
};
export const HINT_RULES = ["puffery"];

const finding = (rule, match, severity = HINT_RULES.includes(rule) ? "hint" : "error") =>
  ({ rule, match: String(match).trim(), fix: FIX[rule], severity });

const words = (s) => s.toLowerCase().match(/[a-z0-9]+(?:['’][a-z]+)?/g) || [];
const stem = (w) => w.replace(/['’]s$/, "").replace(/(ing|ed|es|s)$/, "");
const content = (s) => words(s).filter((w) => !STOP.has(w) && w.length > 1).map(stem);
const sentences = (text) =>
  text.split(/\n+/).flatMap((line) => line.trim().split(/(?<=[.!?])\s+/)).filter((s) => s.split(/\s+/).length > 1);

// The tells inside a sentence: run on headings and body alike.
function phraseFindings(text) {
  const out = [];
  if (text.includes("—")) out.push(finding("em-dash", "—"));
  for (const rx of PHRASES) for (const m of text.matchAll(rx)) out.push(finding("refused-phrase", m[0]));
  for (const rx of NEGATION) for (const m of text.matchAll(rx)) out.push(finding("negation-pivot", m[0]));
  for (const m of text.matchAll(NEGATION_TAIL)) out.push(finding("negation-pivot", m[0], "hint"));
  for (const rx of VAGUE_FIT) for (const m of text.matchAll(rx)) out.push(finding("vague-fit", m[0]));
  for (const m of text.matchAll(ING_RIDER)) out.push(finding("ing-rider", m[0].replace(/^, /, "")));
  for (const m of text.matchAll(WEAK_CTA_IN_TEXT)) out.push(finding("weak-cta", m[0]));
  for (const s of text.split(/(?<=[.!?])\s+|\n+/)) {
    const hits = s.match(PUFFERY);
    if (hits && !/\d/.test(s)) out.push(finding("puffery", [...new Set(hits.map((h) => h.toLowerCase()))].join(", ")));
  }
  return out;
}

function weFindings(text, kind) {
  const we = (text.match(/\b(we|our|us)\b/gi) || []).length;
  const you = (text.match(/\b(you|your)\b/gi) || []).length;
  if (we >= 3 && we > you) return [finding("we-over-you", `we/our ${we}, you/your ${you}`, kind === "page" ? "hint" : "error")];
  return [];
}

// One section: the phrase tells in its heading and body, and the shapes that
// only mean something within a section (triads, rhythm, density).
function sectionFindings(text, { kind = "page", heading = "" } = {}) {
  const out = heading ? phraseFindings(heading) : [];
  if (!text || !text.trim()) return out;
  const label = text.trim().replace(/[\s→›».!]+$/, "");
  out.push(...phraseFindings(text));
  if (WEAK_CTA.test(label) && !out.some((f) => f.rule === "weak-cta")) out.push(finding("weak-cta", label));
  for (const m of text.matchAll(/[^.!?\n]{3,80}\?[ \t]+[A-Z][^.!?\n]{0,60}[.!]/g)) out.push(finding("rhetorical-question", m[0]));
  const triads = text.match(/\b\w+(?: \w+)?, \w+(?: \w+)?,? and \w+(?: \w+)?\b/g) || [];
  const staccato = text.match(/(?:\b[A-Z]\w*(?: \w+){0,2}\. ){2}[A-Z]\w*(?: \w+){0,2}\./g) || [];
  // on a page, lists of real things (parts, services) are often three: a hint;
  // the staccato "No fluff. No filler." is a tell everywhere
  if (triads.length + staccato.length > 1)
    out.push(finding("triads", [...triads, ...staccato].slice(0, 3).join("; "), kind === "page" && !staccato.length ? "hint" : undefined));
  const era = text.match(ERA_WORDS) || [];
  const n = text.split(/\s+/).filter(Boolean).length;
  if (era.length >= 2 && (era.length * 100) / n >= 1.5) out.push(finding("dated-vocabulary", [...new Set(era.map((e) => e.toLowerCase()))].sort().join(", ")));
  const lengths = sentences(text).map((s) => s.split(/\s+/).length);
  if (lengths.length >= 6 && Math.max(...lengths) - Math.min(...lengths) < 12) {
    out.push(finding("uniform-length", `${Math.min(...lengths)} to ${Math.max(...lengths)} words`, "hint"));
  }
  if (heading) {
    const h = new Set(content(heading));
    const first = sentences(text)[0] || text.trim();
    const c = content(first);
    const added = c.filter((w) => !h.has(w));
    if (h.size >= 2 && c.length >= 2 && c.length - added.length >= 2 && added.length <= 1) out.push(finding("restates-heading", first));
  }
  if (kind === "ad") {
    for (const rx of PERSONAL_ATTRIBUTES) {
      const m = text.match(rx);
      if (m) out.push(finding("personal-attribute", m[0]));
    }
  }
  const seen = new Set();
  return out.filter((f) => !seen.has(f.rule + f.match.toLowerCase()) && seen.add(f.rule + f.match.toLowerCase()));
}

/** The tells in one piece of copy, treated as one section. */
export function findings(text, { kind = "page", heading = "" } = {}) {
  return [...sectionFindings(text, { kind, heading }), ...weFindings(`${heading}\n${text || ""}`, kind)];
}

/** The same four-or-more-word phrase in two sections: [{ rule, match, fix, severity, sections: [i, j] }]. */
export function repeated(sections) {
  const toks = sections.map((s) => words(s.body || ""));
  const grams = toks.map((t) => {
    const set = new Set();
    for (let i = 0; i + 4 <= t.length; i++) {
      const g = t.slice(i, i + 4);
      if (g.filter((w) => !STOP.has(w)).length >= 2) set.add(g.join(" "));
    }
    return set;
  });
  const out = [];
  for (let j = 1; j < toks.length; j++) {
    for (let i = 0; i < j; i++) {
      const t = toks[j];
      const k = t.findIndex((_, x) => x + 4 <= t.length && grams[i].has(t.slice(x, x + 4).join(" ")));
      if (k < 0) continue;
      const other = ` ${toks[i].join(" ")} `;
      let end = k + 4;
      while (end < t.length && other.includes(` ${t.slice(k, end + 1).join(" ")} `)) end++;
      out.push({ ...finding("repeated-phrase", t.slice(k, end).join(" ")), sections: [i, j] });
    }
  }
  return out;
}

/** Every section's tells, then what only shows across them: the reader-or-us
 * balance of the whole, and a phrase said twice. Each finding names its
 * `section` (index); a cross-section finding names `sections`. */
export function check(sections, { kind = "page" } = {}) {
  const out = [];
  sections.forEach((s, i) => {
    for (const f of sectionFindings(s.body, { kind, heading: s.heading })) out.push({ ...f, section: i });
  });
  out.push(...weFindings(sections.map((s) => `${s.heading || ""}\n${s.body || ""}`).join("\n"), kind));
  out.push(...repeated(sections));
  return out;
}

/** Markdown (or plain text) into sections: each heading starts one; frontmatter is skipped. */
export function sectionsOf(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  const out = [{ heading: "", body: "" }];
  for (const line of body.split("\n")) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) out.push({ heading: h[1].trim(), body: "" });
    else out[out.length - 1].body += line + "\n";
  }
  return out.filter((s) => s.heading || s.body.trim());
}

// ── the command ──────────────────────────────────────────────────────────
const CAP = 40;
const HELP = `node tropes.mjs [--json] [--kind page|post|ad] <file|->

Checks copy for the tells of generated text. The file is plain text or
markdown; each heading starts a section, checked with its heading and against
the other sections. - reads stdin.

  --kind page   a web page (default); we/you balance is a hint
  --kind post   an organic post
  --kind ad     a paid ad: adds Meta's personal-attribute rule
  --json        [{ rule, match, fix, severity, section?, sections? }] on stdout, every finding

Prints the count first ("tropes: 2 errors, 1 hint in about.md"), then each
finding with its fix, errors first, the first ${CAP}. Exit 1 when there is an
error, 0 when clean or only hints, 2 on a usage error (stderr, with Try:).`;
const TRY = "node .claude/skills/tropes/tropes.mjs --help";

async function main(argv) {
  const opts = { json: argv.includes("--json"), kind: "page", file: null };
  /** A usage error: what was wrong and the command that works, as JSON under --json. Exit 2. */
  const misused = (msg, tryCmd = TRY) => {
    console.error(opts.json ? JSON.stringify({ error: `tropes: ${msg}`, try: tryCmd }) : `tropes: ${msg}\n  Try: ${tryCmd}`);
    return 2;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { console.log(HELP); return 0; }
    if (a === "--json") continue;
    else if (a === "--kind") opts.kind = argv[++i];
    else if (a.startsWith("--kind=")) opts.kind = a.slice(7);
    else if (a !== "-" && a.startsWith("-")) return misused(`unknown option ${a}; valid: --kind, --json`);
    else if (opts.file) return misused(`one file at a time (given ${opts.file} and ${a})`);
    else opts.file = a;
  }
  if (!["page", "post", "ad"].includes(opts.kind)) return misused(`--kind is page, post or ad, not "${opts.kind}"`);
  if (!opts.file) return misused("name a file, or - for stdin");
  let text;
  try {
    text = readFileSync(opts.file === "-" ? 0 : opts.file, "utf8");
  } catch (e) {
    return misused(`cannot read ${opts.file} (${e.code || e.message})`, "node .claude/skills/tropes/tropes.mjs <a file that exists>");
  }
  const sections = sectionsOf(text);
  const found = check(sections, { kind: opts.kind });
  if (opts.json) {
    console.log(JSON.stringify(found.map((f) => ({ ...f, heading: f.section !== undefined ? sections[f.section].heading : undefined }))));
    return found.some((f) => f.severity === "error") ? 1 : 0;
  }
  const errors = found.filter((f) => f.severity === "error");
  const hints = found.length - errors.length;
  if (!found.length) {
    console.log("tropes: clean");
    return 0;
  }
  const what = opts.file === "-" ? "" : ` in ${opts.file}`;
  const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const lines = [`tropes: ${plural(errors.length, "error")}, ${plural(hints, "hint")}${what}. Rewrite each flagged line whole.`];
  // Errors first, so a capped list never hides one behind a hint.
  for (const f of [...errors, ...found.filter((f) => f.severity !== "error")].slice(0, CAP)) {
    const where = f.section !== undefined && sections[f.section].heading ? `  (${sections[f.section].heading})`
      : f.sections ? `  (${f.sections.map((i) => sections[i].heading || `section ${i + 1}`).join(" and ")})` : "";
    lines.push(`  ${f.severity.padEnd(5)} ${f.rule}  "${f.match.slice(0, 80)}"${where}`, `        ${f.fix}`);
  }
  if (found.length > CAP) lines.push(`  ${CAP} of ${found.length} shown; --json for all`);
  console.log(lines.join("\n"));
  return errors.length ? 1 : 0;
}

const isMain = () => {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false; // imported by `node -e`, whose argv[1] is not a file
  }
};
if (isMain()) {
  process.exitCode = await main(process.argv.slice(2));
}

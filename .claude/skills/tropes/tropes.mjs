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
// line to rewrite; "hint" is for the writer to judge and never fails.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
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
  /\bis more than (just )?an? [^.;:!?\n]{1,40}[,;.] it'?s\b/gi,
  // "This isn't about software. It's about your time." "It isn't just a CRM, it's…"
  // a sentence of its own, so "If it isn't working, it's the battery." passes
  /(?<=^|[.!?]\s+)(this|it|that) (isn'?t|is not|wasn'?t) (just|only|merely|really|about) [^.;:!?\n]{1,50}[.;,:—–]\s*(it'?s|this is|that'?s|it was|they'?re)\b/gim,
  /(?<=^|[.!?]\s+)(This|It|That) (isn'?t|is not|wasn'?t) [^.;:!?\n]{1,50}\. (It'?s|This is|That'?s) (about|a|an|the|your|how|what)\b/gm,
  // "Not a template. A real site."
  /(?<=^|[.!?]\s+)Not (a|an|the|just|another|only) [^.!?\n]{1,40}\. (A|An|The|It'?s|Your|Real) /gm,
];
// "Fill your chairs, not your phone." None in 26,000 words of 2020 small-business
// pages, four in 1,300 words of a current model's. An error in a heading and
// with "not just"; in a sentence it can be the plain fact a customer needs
// ("Cash only, not cards."), so there it is a hint.
const NEGATION_TAIL = /\b\w+(?: \w+){0,3}, not (just |only )?\w+(?: \w+){0,3}(?=[.!]|$)/gim;

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

// The current models' own diction (2025 to 2026), each narrowed to the
// figurative use, so a plane landing or a landing page passes.
// Held at zero findings on twenty 2020 small-business homepages.
const MODEL_TELLS = [
  // "lands in your inbox", "the report lands every Monday", "when a lead lands,";
  // a plane, a boat, a catch, a job or a client landed, a landed cost, a
  // landing page and a code token (:landed, "landed") pass
  /(?<!\b(plane|planes|flight|flights|jet|helicopter|drone|aircraft|rocket|ferry|ferries|boat|boats|ship|ships|vessel|fish|catch|we|you|they|I|she|he),?\s)(?<![:"'`_])\b(lands|landed)\b(?!["'`_])(?! (a|an|the|another|more|new|two|three|your first|our first|their first)( \w+)? (job|jobs|client|clients|deal|deals|contract|contracts|role|customer|customers|sale|sales|gig|interview|account|accounts)\b)(?! cost)(?! (this|that|today|each) (morning|week|day))/gi,
  /(?<!\b(flight|flights|plane|planes|ferry|boat|ship|we|you|they|I) )\b(will|to|can|should|they|ones|replies|messages|emails|leads|requests|bookings|deals|orders|payments|invoices|files|updates) land (here|there|in|on|at|directly|straight|right)\b/gi,
  /\blanding (in|on) (your|the|their) (inbox|desk|desktop|phone|lap|calendar)\b/gi,
  /\bwhere (it|they|this|that|everything|I|we) (lands?|landed)\b/gi,
  // the tool brings something up: "It surfaces the leads"; cleaning surfaces passes
  /\b(it|this|that|which|AI|the app|the report|the dashboard|the CRM|the check) surfaces\b/gi, /\bsurfacing (the|any|new|key|issues|problems|insights|risks|opportunities)\b/gi,
  /\bload-bearing\b/gi, /\b(is|are|was|were) doing the heavy lifting\b/gi,
  /(?:^|[.!?]\s+|\b(?:and|but) )(this|that) matters(?=[.!])/gim, /(?:^|[.!?]\s+)why (this|it|that) matters\b/gi, /^why [^.?!\n]{1,40} matters[.?]?$/gim,
  /\bbecause (it|this|that) matters\b/gi,
  /\bit'?s worth (mentioning|saying|stating|calling out|pointing out|flagging)\b/gi, /\bworth stating plainly\b/gi,
  /\bworth (a look|exploring|considering|sitting with|talking about|asking)\b/gi,
  /\brather than simply\b/gi, /\bfull stop[.!]/gi, /\byou'?re absolutely right\b/gi,
  // the staged reveal
  /\bhere'?s (the (real )?(thing|kicker|catch|twist|truth|secret|trick|best part)|where it gets)\b/gi,
  /^the (kicker|twist|upshot|best part|catch)[:?]/gim,
  /\bthe real (issue|problem|reason|question|win|magic|unlock|difference|answer|secret)\b/gi,
  /\bthe (whole|entire|only) point\b/gi, /\b(that'?s|is|was) the (whole|entire) (game|ballgame|idea)\b/gi,
  /\b(it|this|that|AI|the AI|which) hands (you|it back|back)\b/gi, /\b(stays?|remains?) yours\b/gi,
  /\bat its core\b/gi, /\b(this|that) is where \w+(?: \w+)? comes? in\b/gi,
  /\b(trust|value|growth|knowledge|advantage|progress) compounds\b/gi,
  /\blet'?s (break (it|this) down|unpack)\b/gi, /\bshed light on\b/gi,
];
// Common in people's speech too, so only hints.
const MODEL_HINTS = [/\bhonestly\b/gi, /\bquietly\b/gi, /\bgenuinely\b/gi, /\bthe real (cost|value|work|test|story)\b/gi, /\blean(s|ing)? into\b/gi,
  /\b(lives|live) (in|on) (one place|your|the same|its own)\b/gi, /\byours to (keep|own|take)\b/gi,
  /(?:^|[.!?]\s+)(less|fewer) \w+(?: \w+)?[,.] more \w+/gi, /\bat the end of the day\b/gi];

// A complete sentence with a comma and a "with" phrase bolted on to carry the
// claim: "Your site runs on Cloudflare, with its SEO and design done professionally."
const WITH_RIDER = /, with (its|their|your|the|every|all|everything) [^.;!?\n]{1,50}\b(done|handled|built in|taken care of|included|covered|baked in|sorted|managed)\b/gi;

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
  "negation-tail": 'state the claim alone ("Bookings fill your chairs."); keep it only when the "not" is a plain fact a customer needs ("Cash only, not cards.")',
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
  "joined-heading": 'one plain sentence or a plain label: "Fall cleanup in Larkfield starts at $90.", not "Fall cleanup in Larkfield, from $90." or "Garden design: a plan in a week"',
  "repeated-phrase": "say it once, where it matters most",
  puffery: "a number, a name or a source beside it, or cut it",
  "model-tell": 'a figure of speech today\'s models overuse: say the literal thing ("appears here", "starts in the first stage") or cut it',
  "with-rider": "end the sentence at the comma; say the rest as its own sentence with a subject, or cut it",
  "long-heading": "a heading says one thing; move the rest to the line under it",
  "long-hero": "the hero's line under the headline in one or two short sentences; the rest belongs in the sections",
};
export const HINT_RULES = ["puffery", "long-heading", "long-hero"];
const HEADING_WORDS = 12;
const HERO_WORDS = 30;

const finding = (rule, match, severity = HINT_RULES.includes(rule) ? "hint" : "error") =>
  ({ rule, match: String(match).trim(), fix: FIX[rule], severity });

const words = (s) => s.toLowerCase().match(/[a-z0-9]+(?:['’][a-z]+)?/g) || [];
const stem = (w) => w.replace(/['’]s$/, "").replace(/(ing|ed|es|s)$/, "");
const content = (s) => words(s).filter((w) => !STOP.has(w) && w.length > 1).map(stem);
const sentences = (text) =>
  text.split(/\n+/).flatMap((line) => line.trim().split(/(?<=[.!?])\s+/)).filter((s) => s.split(/\s+/).length > 1);

// The tells inside a sentence: run on headings and body alike. `place` is
// "heading", "body" or "text" (a line of any file).
const straight = (t) => String(t).replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
function phraseFindings(raw, place = "body") {
  const text = straight(raw);
  const out = [];
  // between words; a lone "—" standing for an empty value is a placeholder, not prose
  if (/\S\s*—\s*\S/.test(text.replace(/(["'`>(])\s*—\s*(["'`<)])/g, ""))) out.push(finding("em-dash", "—"));
  for (const rx of PHRASES) for (const m of text.matchAll(rx)) out.push(finding("refused-phrase", m[0]));
  for (const rx of NEGATION) for (const m of text.matchAll(rx)) out.push(finding("negation-pivot", m[0]));
  for (const m of text.matchAll(NEGATION_TAIL)) out.push(finding("negation-tail", m[0], place === "heading" || / not (just|only) /i.test(m[0]) ? "error" : "hint"));
  for (const rx of VAGUE_FIT) for (const m of text.matchAll(rx)) out.push(finding("vague-fit", m[0]));
  for (const m of text.matchAll(ING_RIDER)) out.push(finding("ing-rider", m[0].replace(/^, /, "")));
  for (const m of text.matchAll(WITH_RIDER)) out.push(finding("with-rider", m[0].replace(/^, /, "")));
  for (const rx of MODEL_TELLS) for (const m of text.matchAll(rx)) out.push(finding("model-tell", m[0]));
  for (const rx of MODEL_HINTS) for (const m of text.matchAll(rx)) out.push(finding("model-tell", m[0], "hint"));
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

/**
 * A heading made of fragments joined by a colon or a comma ("Garden design: a
 * plan in a week, planted in spring.", "What we do, and what it costs"). A
 * list's commas are fine ("Forms, bookings and payments on the site."), as are
 * numbers (1,412) and times (8:00).
 */
export function joinedHeading(heading) {
  const h = String(heading || "").replace(/(\d),(\d)/g, "$1$2").replace(/(\d):(\d)/g, "$1$2").replace(/\s+/g, " ").trim();
  if (/[A-Za-z)]:\s*\S/.test(h)) return h;
  const parts = h.split(/,\s*/);
  if (parts.length < 2) return null;
  const tail = parts[parts.length - 1];
  const list = / (and|or) /.test(` ${tail}`) && !/^(and|or|but)\b/i.test(tail);
  return list ? null : h;
}

// One section: the phrase tells in its heading and body, and the shapes that
// only mean something within a section (triads, rhythm, density).
function sectionFindings(text, { kind = "page", heading = "" } = {}) {
  heading = straight(heading);
  text = text && straight(text);
  const out = heading ? phraseFindings(heading, "heading") : [];
  if (heading && joinedHeading(heading)) out.push(finding("joined-heading", heading));
  if (heading.split(/\s+/).length > HEADING_WORDS) out.push(finding("long-heading", `${heading.split(/\s+/).length} words: ${heading}`));
  if (!text || !text.trim()) return out;
  const label = text.trim().replace(/[\s→›».!]+$/, "");
  out.push(...phraseFindings(text, "body"));
  if (WEAK_CTA.test(label) && !out.some((f) => f.rule === "weak-cta")) out.push(finding("weak-cta", label));
  for (const m of text.matchAll(/[^.!?\n]{3,80}\?[ \t]+[A-Z][^.!?\n]{0,60}[.!]/g)) out.push(finding("rhetorical-question", m[0]));
  const triads = text.match(/\b\w+(?: \w+)?, \w+(?: \w+)?,? and \w+(?: \w+)?\b/g) || [];
  // three clipped sentences in a row; an abbreviation (Dr., St.) is not one
  const staccato = (text.match(/(?:\b[A-Z]\w*(?: \w+){0,2}\. ){2}[A-Z]\w*(?: \w+){0,2}\./g) || [])
    .filter((m) => !/\b(Dr|St|Mr|Mrs|Ms|Jr|Sr|Inc|Ltd|Co|Ave|Rd|Mt|No|Vol|Fig)\. /.test(m));
  // "No fluff. No filler. Just results." is a tell everywhere; "Licensed. Bonded.
  // Insured." is how a trade says it, so other runs, like lists of three, are hints
  const pivot = text.match(/(?:^|[.!?]\s+)(No|Less|More|Zero|Not) \w+(?: \w+)?\. (No|Less|More|Zero|Not|Just) \w+(?: \w+){0,2}\./gm) || [];
  if (pivot.length) out.push(finding("triads", pivot[0].replace(/^[.!?]\s+/, "")));
  else if (staccato.length) out.push(finding("triads", staccato[0], kind === "page" ? "hint" : undefined));
  else if (triads.length > 1) out.push(finding("triads", triads.slice(0, 3).join("; "), kind === "page" ? "hint" : undefined));
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
  if (kind === "text") return textFindings(text);
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

/** Any text a line at a time (an app's strings, code and its comments, a
 * skill): only the tells inside a sentence. A label, an error or a comment is
 * not a page, so the rhythm, the balance and the calls to action are left alone. */
const TEXT_RULES = ["em-dash", "model-tell", "negation-pivot", "ing-rider", "with-rider", "vague-fit"];
function textFindings(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    // Only today's models' tells and the house em dash rule: "Learn more", "Welcome
    // to the team", "a trusted device" and "Reply to the topic, not a post" are an
    // app's plain words (one finding, an -ing rider, in 90,000 words of 2020
    // Discourse, Mastodon and GitLab strings)
    // "your way" is a plain label in an app ("Get there your way") though a vague promise on a page
    for (const f of phraseFindings(line, "text")) if (TEXT_RULES.includes(f.rule) && f.severity === "error" && f.match.toLowerCase() !== "your way") out.push({ ...f, match: f.rule === "em-dash" ? line.trim() : f.match });
  }
  return out;
}

/** Every section's tells, then what only shows across them: the reader-or-us
 * balance of the whole, and a phrase said twice. Each finding names its
 * `section` (index); a cross-section finding names `sections`. */
export function check(sections, { kind = "page" } = {}) {
  if (kind === "text") return sections.flatMap((s, i) => textFindings(`${s.heading || ""}\n${s.body || ""}`).map((f) => ({ ...f, section: i })));
  const out = [];
  sections.forEach((s, i) => {
    for (const f of sectionFindings(s.body, { kind, heading: s.heading })) out.push({ ...f, section: i });
  });
  out.push(...weFindings(sections.map((s) => `${s.heading || ""}\n${s.body || ""}`).join("\n"), kind));
  out.push(...repeated(sections));
  if (kind === "page") out.push(...heroFindings(sections));
  return out;
}

/** A page's hero is its first section with a heading; its lede is the first
 * line under it of six words or more (a button or a note is shorter). */
function heroFindings(sections) {
  const i = sections.findIndex((s) => s.heading);
  if (i < 0) return [];
  const lede = (sections[i].body || "").split("\n").map((l) => l.trim()).find((l) => l.split(/\s+/).length >= 6);
  const n = lede ? lede.split(/\s+/).length : 0;
  return n > HERO_WORDS ? [{ ...finding("long-hero", `${n} words: ${lede}`), section: i }] : [];
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

// ── every file under a path ──────────────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".venv", "venv", "__pycache__", ".next", ".pytest_cache", ".cache", ".git", "_build", "deps", "vendor", ".wrangler", "coverage", "tmp", "raw", "tropes", ".elixir_ls"]);
const TEXT_FILE = /\.(ex|exs|heex|eex|ts|tsx|js|mjs|cjs|py|md|sh|css|json|ya?ml|toml|sql|html|txt)$/;
const NOT_TEXT = /(\.min\.js|package-lock\.json|\.lock)$/;
const ALLOW = "tropes-allow";

/** The files under each path that hold words, skipping builds, dependencies,
 * crawled pages and the tropes skill itself (it quotes the tells). Symbolic
 * links are not followed; a path that does not exist holds nothing. */
export function textFiles(paths) {
  const walk = (p) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return [];
    if (st.isFile()) return TEXT_FILE.test(p) && !NOT_TEXT.test(p) ? [p] : [];
    return readdirSync(p).filter((n) => !SKIP_DIRS.has(n)).flatMap((n) => walk(join(p, n)));
  };
  return paths.filter((p) => existsSync(p)).flatMap(walk);
}

/**
 * Every line of every file under `paths` through the text rules: code, its
 * comments and strings, templates and skills alike. Two lines are also read as
 * one, so a sentence wrapped across them is caught. A line holding
 * "tropes-allow" is a deliberate example and is skipped, and so, in
 * markdown, are others' words: a blockquote, or text in quotation marks.
 * → [{ file, line, rule, match, fix, severity }]
 */
export function scan(paths) {
  const out = [];
  const bare = (l) => l.replace(/^\s*(\/\/+|\/\*+|#+|\*|--|<!--|<%!--|>|-|\d+\.)?\s*/, "").replace(/\s*(\*\/|-->|--%>)\s*$/, "").trim();
  for (const file of textFiles(paths)) {
    let lines = readFileSync(file, "utf8").split("\n");
    // In markdown, others' words sit in a blockquote or in quotation marks and
    // stay as their author wrote them; blanked, so line numbers hold.
    if (/\.md$/.test(file)) lines = lines.map((l) => (/^\s*>/.test(l) ? "" : l.replace(/"[^"\n]*"|“[^”\n]*”/g, (q) => " ".repeat(q.length))));
    // One finding per line and rule. A sentence read across two lines counts
    // only where neither line already has that rule, so a long match there
    // does not repeat what one line found.
    const seen = new Set();
    const add = (i, f) => {
      if (seen.has(`${i} ${f.rule}`)) return;
      seen.add(`${i} ${f.rule}`);
      out.push({ file, line: i + 1, ...f });
    };
    lines.forEach((l, i) => {
      if (l.includes(ALLOW)) return;
      for (const f of textFindings(l)) add(i, f);
    });
    const single = new Set(seen);
    lines.forEach((l, i) => {
      const next = lines[i + 1];
      if (next === undefined || l.includes(ALLOW) || next.includes(ALLOW) || !bare(l) || !bare(next)) return;
      for (const f of textFindings(`${bare(l)} ${bare(next)}`)) {
        if (f.rule === "em-dash" || single.has(`${i} ${f.rule}`) || single.has(`${i + 1} ${f.rule}`)) continue;
        add(i, f);
      }
    });
  }
  return out;
}

/** A rendered page's words as markdown, for a cold read: headings,
 * paragraphs, list items and [links and buttons]. The site's navigation,
 * header and footer (outside <main>), scripts, pictures (role="img",
 * aria-hidden) and hidden elements are left out. */
export function wordsOf(html) {
  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: "—", ndash: "–", hellip: "…" };
  const VOID = new Set(["img", "input", "br", "hr", "source", "meta", "link", "wbr", "area", "col", "embed", "track"]);
  let h = String(html).replace(/<head\b[\s\S]*?<\/head>/i, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const body = h.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  if (body) h = body[1];
  h = h.replace(/<(script|style|svg|noscript|template|nav)\b[\s\S]*?<\/\1>/gi, " ");
  // the site's own header and footer sit outside <main>; a page's own header inside it is copy
  const main = h.search(/<main\b/i), end = h.search(/<\/main>/i);
  if (main >= 0 && end > main) {
    const chrome = (part) => part.replace(/<(header|footer)\b[\s\S]*?<\/\1>/gi, " ");
    h = chrome(h.slice(0, main)) + h.slice(main, end) + chrome(h.slice(end));
  }
  // a picture's, a hidden or an aria-hidden element's words, by its opening tag to the matching close
  const drop = /<(\w+)\b[^>]*?(role="img"|aria-hidden="true"|\shidden(?=[\s>=/])|class="(?:[^"]*\s)?hidden(?:\s[^"]*)?")[^>]*>/i;
  for (let m = h.match(drop); m; m = h.match(drop)) {
    const tag = m[1].toLowerCase();
    let cut = m.index + m[0].length;
    if (!VOID.has(tag) && !m[0].endsWith("/>")) {
      let depth = 0;
      const rx = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, "gi");
      rx.lastIndex = m.index;
      cut = h.length;
      for (let t = rx.exec(h); t; t = rx.exec(h)) {
        if (t[2]) continue;
        depth += t[1] ? -1 : 1;
        if (depth === 0) { cut = rx.lastIndex; break; }
      }
    }
    h = h.slice(0, m.index) + " " + h.slice(cut);
  }
  const BLOCK = /<\/?(p|div|section|article|header|footer|main|aside|blockquote|figure|figcaption|dd|dt|tr|br|ul|ol|dl|table|form|label|h[1-6]|li)\b/i;
  h = h
    .replace(/\s+/g, " ")
    // a link or button around one line is a [label]; around a card, its words stand alone
    .replace(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, t, x) => (BLOCK.test(x) ? x : ` [${x.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()}] `))
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "")}\n\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|blockquote|figure|figcaption|dd|dt|tr|br|ul|ol|dl|table|form|label)\b[^>]*>/gi, "\n")
    .replace(/<\/?(b|strong|em|i|u|small|code|mark|sup|sub|abbr|s|time|q)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, e) => ENT[e] ?? (e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(1).replace(/^x/, "0x"))) : m));
  return h.split("\n").map((l) => l.replace(/[ \t]+/g, " ").replace(/ ([,.;:!?])/g, "$1").trim()).filter((l) => l !== "-").join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ── the command ──────────────────────────────────────────────────────────
const CAP = 40;
const HELP = `node tropes.mjs [--json] [--kind page|post|ad] <file|->
node tropes.mjs --scan [--json] [--all] <path>...
node tropes.mjs --words <page.html|->

Checks copy for the tells of generated text.

The first form checks one piece of copy: plain text or markdown, where each
heading starts a section, checked with its heading and against the others.
- reads stdin.
  --kind page   a web page (default); we/you balance is a hint
  --kind post   an organic post
  --kind ad     a paid ad: adds Meta's personal-attribute rule
  --kind text   any text a line at a time: only the tells inside a sentence

--scan reads every file under each path a line at a time with the text rules:
code, its comments and strings, templates, skills. Builds, dependencies,
crawled pages and this skill are skipped; a line holding "tropes-allow" is a
deliberate example. Prints each finding as file:line, then each rule's fix
once; the first ${CAP} (--all for every one).

--words prints a built page's words as markdown, for a cold read: headings,
paragraphs, list items and [buttons]; navigation and pictures left out.

  --json        the findings as JSON on stdout

Prints the count first ("tropes: 2 errors, 1 hint in about.md"). Exit 1 when
there is an error, 0 when clean or only hints, 2 on a usage error (stderr,
with Try:).`;
// The path this was run by, so the Try: line works from where it was run.
const SELF = (() => {
  try {
    return relative(process.cwd(), fileURLToPath(import.meta.url)) || "tropes.mjs";
  } catch {
    return ".claude/skills/tropes/tropes.mjs";
  }
})();
const TRY = `node ${SELF} --help`;
const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

async function main(argv) {
  const opts = { json: argv.includes("--json"), all: false, kind: "page", mode: "copy", paths: [] };
  /** A usage error: what was wrong and the command that works, as JSON under --json. Exit 2. */
  const misused = (msg, tryCmd = TRY) => {
    console.error(opts.json ? JSON.stringify({ error: `tropes: ${msg}`, try: tryCmd }) : `tropes: ${msg}\n  Try: ${tryCmd}`);
    return 2;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { console.log(HELP); return 0; }
    if (a === "--json") continue;
    else if (a === "--all") opts.all = true;
    else if (a === "--scan" || a === "--words") {
      const mode = a.slice(2);
      if (opts.mode !== "copy" && opts.mode !== mode) return misused("--scan and --words are separate commands; give one");
      opts.mode = mode;
    }
    else if (a === "--kind") opts.kind = argv[++i];
    else if (a.startsWith("--kind=")) opts.kind = a.slice(7);
    else if (a !== "-" && a.startsWith("-")) return misused(`unknown option ${a}; valid: --kind, --scan, --words, --all, --json`);
    else opts.paths.push(a);
  }
  if (!["page", "post", "ad", "text"].includes(opts.kind)) return misused(`--kind is page, post, ad or text, not "${opts.kind}"`);
  if (opts.mode !== "copy" && argv.some((a) => a === "--kind" || a.startsWith("--kind="))) return misused(`--kind applies to one piece of copy, not to --${opts.mode}`);
  if (opts.all && opts.mode !== "scan") return misused("--all applies to --scan");
  if (opts.json && opts.mode === "words") return misused("--words prints markdown; --json applies to the checks");
  if (!opts.paths.length) return misused(opts.mode === "scan" ? "name a file or a folder to scan" : "name a file, or - for stdin");
  if (opts.mode !== "scan" && opts.paths.length > 1) return misused(`one file at a time (given ${opts.paths.join(", ")}); --scan takes several`);
  const read = (f) => readFileSync(f === "-" ? 0 : f, "utf8");

  if (opts.mode === "scan") {
    const missing = opts.paths.filter((p) => !existsSync(p));
    if (missing.length === opts.paths.length) return misused(`nothing to scan: ${missing.join(", ")} not found`, `node ${SELF} --scan <a file or folder that exists>`);
    if (missing.length) console.error(`tropes: not found, skipped: ${missing.join(", ")}`);
    let found;
    try {
      found = scan(opts.paths);
    } catch (e) {
      return misused(`cannot read ${e.path || opts.paths.join(", ")} (${e.code || e.message})`, `node ${SELF} --scan <a file or folder that exists>`);
    }
    if (opts.json) {
      console.log(JSON.stringify(found));
      return found.length ? 1 : 0;
    }
    if (!found.length) {
      console.log(`tropes: clean (${opts.paths.join(", ")})`);
      return 0;
    }
    const files = new Set(found.map((f) => f.file)).size;
    const lines = [`tropes: ${plural(found.length, "finding")} in ${plural(files, "file")}. Rewrite each line whole.`];
    const shown = opts.all ? found : found.slice(0, CAP);
    for (const f of shown) lines.push(`  ${f.file}:${f.line}  ${f.rule}  "${f.match.slice(0, 90)}"`);
    if (shown.length < found.length) lines.push(`  ${shown.length} of ${found.length} shown; --all for the rest`);
    lines.push("Fixes:");
    for (const rule of new Set(shown.map((f) => f.rule))) lines.push(`  ${rule}: ${FIX[rule]}`);
    console.log(lines.join("\n"));
    return 1;
  }

  let text;
  try {
    text = read(opts.paths[0]);
  } catch (e) {
    return misused(`cannot read ${opts.paths[0]} (${e.code || e.message})`, `node ${SELF} <a file that exists>`);
  }
  if (opts.mode === "words") {
    process.stdout.write(wordsOf(text));
    return 0;
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
  const what = opts.paths[0] === "-" ? "" : ` in ${opts.paths[0]}`;
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

---
name: tropes
description: "Finds and removes the tells of AI-made work in copy, pictures and video before the owner sees it. Use after drafting any page, ad, post or picture, before showing or sending it, or when the owner says it sounds or looks like AI. Not for writing the first draft."
---

# Tropes

A tell is an unspecified default: the model's average where this business's
particular should be. Readers and platforms trust work that reads as
generated less, so it costs the owner customers and reach. Fix it with the
specific thing that was missing, not a synonym.

Version: 0.3.0 (taskandtool/skills)

## Copy, by script

One set of tells for everything the AI writes; two ways to check it.

- **Every line, anywhere:** `node .claude/skills/tropes/tropes.mjs --scan
  <file or folder>...` reads code, comments, strings, templates, notes and
  skills a line at a time: the figures of speech, the pivots, the riders,
  the em dash. Others' words in markdown (a blockquote, text in quotation
  marks) are left alone; a line holding `tropes-allow` is a deliberate
  example. Each app's own check runs it over what the AI writes.
- **A piece of copy, whole:** `node .claude/skills/tropes/tropes.mjs
  [--kind page|post|ad] <file>` adds what only shows across a page, post or
  ad: triads, rhythm, "X, not Y", joined headings, the hero's length.
  Markdown headings split it into sections. The app's check runs it on its
  output (`npm run check:copy` on a website's built pages, `npm run check`
  on the CRM's proposals, `python3 scripts/check.py` on Marketing's
  creatives).

`error` fails the check (exit 1); a `hint` is for you to judge and never fails: a
real list of three stays. For a cold read, `--words <page.html>` prints a
built page's words as markdown.

## Fixing a finding

- Rewrite the flagged line whole; never patch the phrase, and never add a
  fact to fill the gap a cut left. A missing fact is a `NEED:` line for the owner.
- Strongest tells first: invented proof, the negation pivot and "X, not Y",
  today's models' figures of speech ("lands in your inbox", "hands you"),
  then older vocabulary.
- An owner who insists on a flagged phrase keeps it; the website marks it
  `data-lint-allow="<rule>"`.

## By eye

The script lets some through. Read the copy aloud against the brand's voice
notes: would the owner say it, could a competitor run it unchanged, is the
one triad or contrast earned? Then pictures at full size and at 25%
(`references/images.md`), and video frames at 0, 25, 50, 75 and 100%
(`references/video.md`). Generated people never stand in for customers,
staff or testimonials; the owner's own photograph beats any fix to a
generated one.

## References

- `references/copy.md`: vocabulary, structures, rhythm and claims, each with
  its fix and the rule id the script prints
- `references/images.md`, `references/video.md`: picture and video tells

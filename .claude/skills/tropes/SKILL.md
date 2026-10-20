---
name: tropes
description: "Finds and removes the tells of AI-made work in copy, pictures and video before the owner sees it. Use after drafting any page, ad, post or picture, before showing or sending it, or when the owner says it sounds or looks like AI. Not for writing the first draft."
---

# Tropes

A tell is an unspecified default: the model's average where this business's
particular should be. Readers and platforms trust work that reads as
generated less, so it costs the owner customers and reach. Fix it with the
specific thing that was missing, not a synonym.

Version: 0.1.1 (taskandtool/skills)

## Copy, by script

The app's own check runs the script: `npm run check:copy` (the Website),
`npm run check` (the CRM's proposal words) or `python3 scripts/check.py`
(Marketing). For any other text:

```
node .claude/skills/tropes/tropes.mjs [--kind page|post|ad] [--json] <file|->
```

Markdown headings split the text into sections; each is checked with its
heading and against the others. Each finding prints its rule, the words and
the fix. `error` fails the check (exit 1); `hint` is worth a look and never
fails: a real list of three stays.

## Fixing a finding

- Rewrite the flagged line whole; never patch the phrase, and never add a
  fact to fill the gap a cut left. A missing fact is a `NEED:` line for the owner.
- Strongest tells first: invented proof, the negation pivot, significance
  inflation, then vocabulary.
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

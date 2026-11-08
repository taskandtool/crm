---
name: tropes
description: "Finds and fixes the signs that copy, pictures or video were made by AI, before the owner sees them. Use after drafting any page, post, article, ad, email or picture, before showing or sending it, or when the owner says it sounds or looks like AI. Not for the first draft (writing)."
---

# Tropes

Readers and platforms trust copy less when it sounds generated. Most tells
are a default the model reached for because it lacked a fact about this
business, so the fix is that fact, never a synonym.

## The check

- `node .claude/skills/tropes/tropes.mjs <file>` checks one finished page,
  post, article, ad or email (`--help` lists the `--kind`s).
- `--scan <file or folder>...` checks every line the AI wrote anywhere. It
  skips quoted words and any line marked `tropes-allow`.
- `--words <page.html>` prints a built page's words for a cold read.

An `error` fails the check; a `hint` is yours to judge. The app's own check
(`AGENTS.md`) runs it.

## Fixing

Rewrite the whole sentence; patching a phrase keeps the shape. A missing
fact is a `NEED:` line for the owner. Fix these first: invented proof, the
pivot ("it's not X, it's Y") and figures of speech ("lands in your inbox"). A phrase
the owner insists on stays; on a website, mark it `data-lint-allow="<rule>"`.

The script only knows patterns people rarely write. The rest need the cold
read in the `writing` skill, with `references/copy.md`.

## Pictures and video

Look at pictures at full size and at 25% (`references/images.md`), and
video at its start, each quarter and its end (`references/video.md`). A
generated person never stands in for a customer, staff member or reviewer.

---
name: tropes
description: "Finds and fixes the signs that copy, pictures or video were made by AI, before the owner sees them. Use after drafting any page, post, article, ad, email or picture, before showing or sending it, or when the owner says it sounds or looks like AI. Not for writing the first draft."
---

# Tropes

Readers and platforms trust copy less when it sounds generated. Most tells
are a default the model reached for when it lacked a fact about this
business. Fix one with that fact, not a synonym.

## The check

The main check is a cold read with `references/copy.md`. Do it even when
the script is clean: most tells are shapes a pattern can't find. Where the
app has a `writing` skill, the read is part of it.

The script checks for em dashes and a few phrases and shapes today's models
overuse:

- `node .claude/skills/tropes/tropes.mjs <file>` checks one finished page,
  post, article, ad or email (`--help` lists the `--kind`s).
- `--scan <file or folder>...` checks every line the AI wrote anywhere. It
  skips quoted words and any line marked `tropes-allow`.
- `--words <page.html>` prints a built page's words for the cold read.

An `error` fails the check; a `hint` is yours to judge. The app's own check
(`AGENTS.md`) runs it.

## Fixing

Rewrite the whole sentence; patching a phrase keeps the shape. Write a missing
fact as a `NEED:` line for the owner. Fix these first: a thing doing the
verb, invented proof and the pivot. Keep a phrase the owner insists on; on
a website, mark it `data-lint-allow="<rule>"`.

## Pictures and video

Look at pictures at full size and at 25% (`references/images.md`), and
video at its start, each quarter and its end (`references/video.md`). A
generated person never stands in for a customer, staff member or reviewer.

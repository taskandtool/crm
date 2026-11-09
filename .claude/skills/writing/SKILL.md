---
name: writing
description: "Writes and edits the words people read: a page, a blog post or article, an ad, a social post, an email, a proposal, an app's labels and messages. Use whenever words are written or rewritten, or the owner says they sound generic or salesy."
---

# Writing

Write for someone skimming on a phone, who leaves when they can't tell
what's in it for them. Say what the business does and what the reader gets,
in words a person would say out loud. Clear beats clever.

## Facts and voice

The owner's notes are the only source; the app's `AGENTS.md` names them.
When the words need a fact the notes don't have, write a `NEED:` line for
the owner instead of a vaguer sentence. Never invent customers, results,
awards or urgency. A rating carries its count and source.

Follow `brand/voice.md`, plainer where the owner's own copy is marketese.
Plain still sounds like the owner: keep their warmth and humour, carried by
a true detail ("If your boiler is older than your car, we'll tell you
straight whether it's worth fixing"). Quote one of their lines at most once
in a piece.

## The standard

1. **Keep a line only if it says** the reader's problem, what they get,
   why to believe it, or how little it takes.
2. **Lead with the value.** The first line says what this is and what the
   reader gets, before how it works. A page headline is usually under ten
   words.
3. **Specific beats general.** "Six roofs in one day in Coles Crossing"
   says more than "fast, reliable service".
4. **One idea per sentence.** A second idea after a comma gets its own
   sentence or goes.
5. **Plain words,** contractions, no figures of speech. A request appears;
   it doesn't land.
6. **A heading is one plain sentence or a plain label,** with no period.
7. **Say each fact once.** Each section adds something new.
8. **Vary the rhythm.** A four-word sentence beside a thirty-word one. A
   list is as long as the real list.
9. **One action, named by what the reader gets** ("Book a visit"), worded
   the same everywhere.
10. **Quote others exactly,** in quotation marks, credited as the source
    gives them, never as a heading.

The tells to avoid, and the check that names them: the `tropes` skill.

## Each kind of piece

- **A page:** answer the visitor's questions in the order they ask them
  (what is it, is it for me, what does it cost, how do I start). The app's
  page skill has the rest.
- **An article:** answer the question in the first paragraph, as directly
  as the facts allow, then the steps or the detail. No opening about why
  the topic matters, no summary at the end.
- **An ad or a post:** the hook first, one idea (the `copywriting` skill).
- **An email:** one reason to open it, in the subject line, and one thing
  to do.
- **An app's words:** what happened or what to do next, nothing more.

## Examples

A page:

Draft: "Experience seamless boiler care with our dedicated team of experts. It's not just a service, it's peace of mind." <!-- tropes-allow -->

Rewrite: "The engineer who fitted your boiler services it. Same two of us
since 2004, from Headingley to Horsforth. Book your service before the
first cold week."

An article answering "How often should a boiler be serviced?":

Draft: "In today's busy world, it's easy to forget about your boiler. But regular servicing plays a crucial role in keeping your home warm, safe and efficient. Let's dive in." <!-- tropes-allow -->

Rewrite: "Once a year, ideally in early autumn before the heating goes on.
Most manufacturers ask for a yearly service to keep the warranty valid.
Below is what the engineer checks, how long it takes, and what it costs
in Leeds."

## Checking

Edit in this order: truth (every fact is in the notes), meaning, order,
words, sound (read it aloud), length. Then run the app's check (`AGENTS.md`
names it) and fix what it flags (the `tropes` skill says how).

Then the cold read, the main check, on what this turn changed:

1. Get the words alone. For a built page:
   `node .claude/skills/tropes/tropes.mjs --words dist/<page>.html > /tmp/<page>.md`.
2. Give a fresh sub-agent only that file, the notes, `brand/voice.md` and
   the tropes skill's `references/copy.md`. It lists every line that should
   change as `| line, exactly | replacement, or CUT | why |`. Rules the
   page's skill sets still apply. Each replacement must pass the same list.
3. Apply the table in one pass. With no sub-agent, read it yourself as a
   stranger would, and say so.

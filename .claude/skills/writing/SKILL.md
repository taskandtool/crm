---
name: writing
description: "Writes and edits the words people read: a page, a blog post, an ad, a social post, an email, a proposal, an app's labels and messages. Clear, specific and true, then a cold read. Use whenever words are written or rewritten, or the owner says they sound generic or salesy."
---

# Writing

Clear beats clever, and clear beats voice. A reader skims, gives a line a
second or two, and leaves when they can't tell what it offers. Write what
the business does and what the reader gets, in words a person would say.

Version: 0.1.0 (taskandtool/skills)

## Where the words come from

The facts are the owner's notes this app keeps (its `AGENTS.md` names them:
`public/` and `brand/` on a website, `claims.md` in Marketing). Nothing else
is a source. A fact the words need and the notes don't hold is a `NEED:`
line for the owner, never a vaguer sentence in its place. A rating carries
its count and source; customers, results, awards and urgency are never
invented. The voice is
`brand/voice.md`: follow it, and write plainer than the owner where their
own copy is marketese.

## The standard

1. **Keep a line only if it names the reader's problem, what they get, why
   to believe it, or how little it takes.** Cut the rest; a section that
   does none of these goes.
2. **The first line answers the reader's question.** A headline a stranger
   could repeat: what this is and what they get. On a page, a headline
   usually under ten words and a sentence or two under it.
3. **The benefit, not the mechanism:** "Pages load fast from servers near
   each visitor", not "Hosted on Cloudflare".
4. **Specific beats general:** a number with its unit, a place, a name, a
   step, the words customers use in their reviews. "Six roofs in one day in
   Coles Crossing", not "fast, reliable service".
5. **Words a person would say aloud.** Plain verbs (use, book, fit, send),
   contractions, no figures of speech: a request *appears*, it doesn't
   *land*. The tells are the `tropes` skill's; its check names them.
6. **A heading is one plain sentence or a plain label,** never two
   fragments joined by a comma or a colon.
7. **Others' words stay exactly as written,** in quotation marks (a
   `<blockquote>` on a page), shortened only with "…", credited as the
   source gives them, never a heading.
8. **Vary the rhythm:** a four-word sentence beside a thirty-word one, at
   most one list of three, the odd aside.
9. **One action, named by what the reader gets** ("Book a visit", not
   "Learn more"), worded the same everywhere.

## Each kind of piece

The standard holds for all of them; what changes is who is reading and why.

- **A page** is read by someone who chose to come: answer their questions in
  the order they ask them (what is it, is it for me, what does it cost, how
  do I start), one job per section. The app's page skill has the rest.
- **A blog post** is read by someone with the question it answers: answer it
  in the first paragraph, then the steps, the example or the detail. No
  opening about why the topic matters, no summary at the end.
- **An ad or a social post** interrupts someone doing something else: the
  hook comes first and has to stop them, one idea, sized to the platform
  (Marketing's `copywriting` skill).
- **An email** has one reason to be opened, said in its subject line, and
  one thing to do.
- **An app's words** (a label, an empty state, an error, a notice) are read
  mid-task: say what happened or what to do next, nothing more.

## Editing

In this order: truth (every fact in the notes), meaning (one idea), order,
the words, sound (read it aloud), length. Then the app's check, which runs
the `tropes` skill on everything the AI wrote (`AGENTS.md` names the
command). Rewrite the passage it flags whole; never swap one word.

Draft: "Experience seamless boiler care with our dedicated team of experts.
It's not just a service, it's peace of mind." <!-- tropes-allow -->

Rewrite: "The engineer who fitted your boiler services it. Same two of us
since 2004, from Headingley to Horsforth. Book your service before the
first cold week."

## The cold read

A checker misses jargon, vague claims and a sentence shape used three
times. A fresh reader catches them. Read what this turn changed (one page,
one ad, one email), not the whole site, unless the owner asks for that.

1. **The words alone, as markdown.** A built page:
   `node .claude/skills/tropes/tropes.mjs --words dist/<page>.html > /tmp/<page>.md`
   (headings, paragraphs, list items and `[buttons]`; no markup, navigation
   or pictures). An ad, post or email is already words.
2. **A fresh sub-agent** gets only that file, the notes and `brand/voice.md`,
   and lists every line that should change: `| line, exactly | replacement,
   or CUT | why |` (a claim the notes don't hold, a line no person would say,
   jargon, a vague line, a tell the check missed).
3. **Apply the table in one pass.** Without a sub-agent, read the words
   yourself as a stranger, and say so.

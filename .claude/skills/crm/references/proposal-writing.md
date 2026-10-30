# Writing a proposal's words

Read when writing or changing the words in a proposal component, or when the
owner says one sounds generic, salesy or not like them. The `writing` skill
holds the standard, the editing order and the cold read; this file adds what
a proposal needs.

- **Each component says one thing the customer wants to know** (who you are,
  how the job goes, what it costs), in its first line.
- **A title names what is below it** ("How the job goes", "Your crew"),
  never a slogan or a label above a label.
- **Reviews go in the reviews component,** word for word.
- **A job with no stated result** still has its photograph, its place and
  what was done. Where two sources disagree, use the business's newest own
  page.
- **The reply says what went in,** not what is missing, what conflicted or
  what the owner could add.

`npm run check` runs the `tropes` skill on every component's words. For the
cold read, after `node scripts/proposal-preview.mjs`:
`node .claude/skills/tropes/tropes.mjs --words uploads/proposal-preview/page.html`
gives the sub-agent the page's words alone.

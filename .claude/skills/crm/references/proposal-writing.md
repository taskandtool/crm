# Writing a proposal's words

Read when writing or changing the words in a proposal component, or when the
owner says one sounds generic, salesy or not like them.

The facts a component may state are in `public/` and `brand/`; nothing else
is a source. The voice is `brand/voice.md`: write so the owner would say it
across a kitchen table, and keep their own phrasing wherever it is clear.

- **Each component says one thing a homeowner wants to know** (who you are,
  how the job goes, what it costs), in its first line.
- **Specific beats general:** a real number, place, step or name from the
  notes, and the words customers use in their reviews. "Six roofs in one
  day in Coles Crossing", not "fast, reliable service".
- **A title names what is below it** ("How the job goes", "Your crew"),
  never a slogan or a label above a label.
- **Others' words stay exactly as written:** reviews in the reviews
  component, verbatim, credited as the source gives them, never a heading.
- **Nothing is invented,** and nothing missing is mentioned: what no source
  gives is left out of the page and out of the reply.

`npm run check` runs the `tropes` skill on every component's words, with the
fix for each finding (`.claude/skills/tropes/SKILL.md` lists the tells).
Rewrite the whole passage it flags, never only the word.

## The cold read

After `node scripts/proposal-preview.mjs`, give a fresh sub-agent only the
page's words (`uploads/proposal-preview/page.html`), `public/` and
`brand/voice.md`, and ask for every line that should change as
`| line, exactly | replacement, or CUT | why |`: a claim the notes do not
hold, a line no person would say, a vague line, a tell the check missed.
Apply the table in one pass. Without a sub-agent, read the page yourself as
a stranger and say so.

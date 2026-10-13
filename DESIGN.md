# DESIGN.md

The CRM's design system: what each token in `styles/theme.css` is for and
what to refuse. It is an internal tool a team opens many times a day, so
the rules are an app's: dense, quiet, one accent, colour only where it
carries meaning. `npm run check` enforces the parts that can be checked.

## Color roles

| Token | Role |
|---|---|
| `--color-canvas` | The page. |
| `--color-surface` | A card, a section, a row list, a panel that floats. |
| `--color-panel` | A pipeline column, a flash, a hover, the current nav item. |
| `--color-ink` / `ink-2` / `ink-3` | Text, secondary text, metadata. Every pair meets 4.5:1 on canvas and panel. |
| `--color-accent` / `accent-ink` / `accent-hover` | The one action colour: a page's primary action, Save, the focus ring; `accent-hover` under the pointer. A badge in it (New, a won stage) is a 10% tint with accent text, never filled: a filled accent is a button. |
| `--color-late` | Something past its day, always in its words, never a colour alone: an overdue task ("Overdue"), an event not marked after its time ("Late"), an invoice past due ("Past due"). Nothing else is red. |
| `--color-line` / `line-strong` | Hairlines; input, button and table edges. `line-strong` keeps 3:1 on every ground, the floor for a control's edge. |

Change a value in `styles/theme.css` and keep its row here. The Tailwind
default palette is off, so `bg-blue-500` does not exist; add a role.
Badges (`src/admin/status.tsx`) use only these tokens: an open stage is
a tint (open strong, won the accent, lost muted), never an outline: an
outlined badge reads as a button. An error (nothing was
saved) is an alert set apart by weight and a heavy left edge, not by red.

## Type and space

One family (`--font-body`), three sizes: `text-title` (a page heading),
`text-copy` (everything), `text-label` (metadata, filters, buttons).
Weights: normal and semibold. Radii: `rounded-control` for inputs,
buttons and badges, `rounded-card` for cards and sections. Depth:
`shadow-card` on every card, table and control, `shadow-lift` on something
that floats. Controls and buttons are one height (`min-h-9`), so a row of
them lines up; their classes come from `src/admin/status.tsx`, never
written again. A link is underlined in `line-strong` until pointed at.

## Composition

- Every page is one frame: the list it belongs to above the title, the
  title, then one line of who it is for (company, phone, email), with the
  page's actions on the right. At most one action is primary.
- A list page's primary action is **New** (New customer, New request, New
  event), a page of its own. A record's page reads as values with **Edit**
  for the form; who added it is one quiet line at its foot, beside Merge
  and Archive.
- Dates drop the year in this one and the time where the day is the point
  (last contact, closed). Totals on the board and the Inbox are whole
  units; quotes and invoices keep cents.

- The Inbox is a list, not a table, so a row wraps on a phone: what it
  was and when, the person, then the one action that matters.
- The customers list hides columns as the screen narrows; the name and
  stage always stay.
- The pipeline is a horizontal row of columns; it scrolls sideways on a
  phone and never widens the page.
- One accent colour does every primary action. Danger is not red: Archive
  is a plain button with a clear label, and nothing is deleted.
- Motion: SortableJS's drag animation and nothing else. Reduced motion
  turns it off.

## Words

The standard CRM words, one name per action: the `admin` skill's Words.

## Refuse

Hex values or default Tailwind colours in markup, gradients, blur, glass,
gradient text, `animate-*`, tracking or leading overrides, weights above
semibold, arbitrary text sizes, em dashes in interface copy.

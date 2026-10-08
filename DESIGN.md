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
| `--color-accent` / `accent-ink` | The one action colour: Add, Save, a New badge, a won stage, the focus ring. |
| `--color-late` | An overdue follow-up, in its words ("Overdue"), never a colour alone. Nothing else is red. |
| `--color-line` / `line-strong` | Hairlines; input, button and table edges. `line-strong` keeps 3:1 on every ground, the floor for a control's edge. |

Change a value in `styles/theme.css` and keep its row here. The Tailwind
default palette is off, so `bg-blue-500` does not exist; add a role.
Badges (`src/admin/status.tsx`) use only these tokens: an open stage is
strong, won is the accent, lost is muted.

## Type and space

One family (`--font-body`), three sizes: `text-title` (a page heading),
`text-copy` (everything), `text-label` (metadata, filters, buttons).
Weights: normal and semibold. Radii: `rounded-control` for inputs and
buttons, `rounded-card` for cards and sections. Depth: `shadow-card` on a
pipeline card, `shadow-lift` on something that floats.

## Composition

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

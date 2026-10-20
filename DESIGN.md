# DESIGN.md

The CRM's design system: what each token in `styles/theme.css` is for, how
a page is put together, and what to refuse. `styles/theme.css` is the
Tailwind config (Tailwind v4 reads its `@theme`); there is no
`tailwind.config.js`. `npm run check` enforces what can be checked.

It is a tool a team opens many times a day, so it should look like the best
admin templates (Tailwind's Catalyst, Linear, Stripe's dashboard): calm,
light, clearly ranked. That comes from four things, in this order:

1. **Contrast of size, not of boxes.** A figure is big, a label is small,
   and the eye knows where to start. Sections are separated by space and
   a hairline, not by drawing a card around everything.
2. **Quiet edges where words do the work.** A button says what it does, so
   its ring is faint; an empty field has only its edge, so that edge is
   firm. Dark outlines on every button read as a form, not an app.
3. **People as faces.** Every person has an initials avatar in the same
   colour on every page, and every nav item has an icon.
4. **Colour that means something.** The accent for actions, green for good
   news, red for late, a tint per person. Everything else is grey.

## Color roles

| Token | Role |
|---|---|
| `--color-canvas` | Behind the page: the sidebar's ground, and the strip around the panel. |
| `--color-surface` | The page panel, a card, a control, a menu. |
| `--color-panel` | A pipeline column, a hover, the current nav item on a phone, a neutral badge. |
| `--color-ink` / `ink-2` / `ink-3` | Names and figures; secondary text; metadata. Each meets 4.5:1 on surface and panel. |
| `--color-accent` / `accent-ink` / `accent-hover` | The one action colour: a page's primary button, a count in the nav, a link, the focus ring. As a badge it is a 10% tint with accent text, never filled: a filled accent is a button. |
| `--color-good` | Good news only: a figure up on last period, paid, won. Text or a 10% tint, never a fill. |
| `--color-late` | Past its day, and nothing else: an overdue task ("Overdue"), an event not marked after its time ("Overdue"), an invoice past due ("Past due"). Always with the words; never colour alone. A figure going down is not late: it takes a neutral chip. |
| `--color-hue-1` … `hue-6` | Avatars only: initials on a 12% tint of one hue, picked from the name (`Avatar` in `src/views/ui.tsx`). Never for anything else. |
| `--color-line` | Hairlines between rows and around cards, and a button's ring. |
| `--color-line-strong` | An input's, select's or checkbox's edge, and a link's underline: 3:1 on every ground, as WCAG 1.4.11 asks of a field's boundary. |

Change a value in `styles/theme.css` and keep its row here and its contrast
figure in the comment. The Tailwind default palette is off, so
`bg-blue-500` does not exist; add a role. Opacity modifiers on a role are
fine (`bg-good/10`, `bg-surface/60`).

## Type

One family (`--font-body`, the system UI face) and five sizes:

| Class | Size | For |
|---|---|---|
| `text-display` | 30px | A figure: Home's numbers, a total that is the point of the page. |
| `text-title` | 24px | The page's heading. One per page. |
| `text-heading` | 16px | A section's heading on a record page, the sidebar's name. |
| `text-copy` | 14px | Everything else: rows, cells, cards, forms, buttons. The body default. |
| `text-label` | 12px | Metadata: dates, counts, a badge, a column's head, a line under a name. Never smaller. |

Weights: normal for reading, **medium** (500) for names, nav items and
labels that lead a row, **semibold** (600) for headings, figures, buttons
and money that is the point of a card. Nothing heavier.

Figures that sit in columns or change (money, counts, phone numbers) take
`tabular-nums`, so they line up and do not jitter.

The ranking on a list row is always the same three steps: the name
(`text-copy` medium, `ink`), one line of metadata (`text-label`, `ink-3`,
parts joined by a middle dot), then what it was (`text-copy`, `ink-2`).

## Space

- The page heading sits `mb-8` above the content; sections are `mb-12`
  apart. Space separates sections; a hairline (`border-t border-line`)
  marks where one starts.
- Rows are `py-4` with a hairline between them. Table cells are
  `px-4 py-3`. A card is `p-3` (a board card) or `p-4` (a section).
- Inside a row, the gap between the avatar and the text is `gap-3`;
  between buttons, `gap-2`.

## Edges and depth

- Radii: `rounded-control` (8px) for inputs, buttons, badges, menus and
  board cards; `rounded-card` (12px) for the page panel, a section card and
  a pipeline column; `rounded-full` for avatars and count pills.
- Depth: `shadow-card` with `ring-1 ring-line` on a card or the panel;
  `shadow-lift` on something that floats (a menu, a dragged card). A card
  never has both a border and a ring.
- Not everything is a card. The leads and section headings sit straight
  on the panel. A card is for a group that is one thing: a section of a
  record page, a deal, a table, one of Home's figures or short lists.

## The frame

The sidebar layout of Catalyst and Tailwind Plus, with what a CRM adds
(HubSpot's and Pipedrive's search and Create):

- **The sidebar** (240px, on the canvas), top to bottom: the business name
  (Settings, Business, once it is set, else "CRM"); **search**, which finds every kind of record (contacts, leads,
  deals, quotes, invoices), a few of each under the box as you type and the
  whole page on Enter, with `/` to focus it from any page; **New**, a menu
  of everything that can be made (customer, deal, task, event, quote,
  invoice, as this CRM has them), each its own page; the sections with
  their icons and counts (Home, Leads, Tasks, Contacts, Deals, Schedule,
  Quotes, Invoices); then, at the foot, **Settings** and the signed-in
  person with their avatar.
- **Settings** is one page of everything about how the business is set
  up, apart from the daily work, as all four CRMs keep it behind one
  Settings: Forms, Stages and statuses, Services, Team, Tax rates. Each
  of those pages goes back to Settings. Deals keeps Edit stages on the
  board too, as Pipedrive and Jobber do.
- **The current section** is a white pill with a ring; the rest are
  `ink-2` with an `ink-3` icon.
- **The page** sits on one white panel inset 8px from the window,
  rounded, with `shadow-card` and a ring. Its column is `max-w-6xl`; the
  board (`wide`) uses the whole panel.
- **Below `lg`:** a bar with the menu button and the name. The button opens
  the same sidebar as a drawer over a dimmed page, which is inert while it
  is open; Escape, the close button or a tap on the page closes it.
  Without JavaScript the button is a `#nav` link and `:target` opens it.

## Composition

- **Every page is one frame:** the list it belongs to above the title (a
  small `ink-3` link with a ←), the title, then one line under it (the
  status badge first, then who it is for and the key figure), with the
  page's actions on the right. At most one action is primary.
- **A list page's one action is New** (New lead, New contact, New deal),
  a page of its own, primary. Nothing else sits there but a link to the
  setting that shapes the list where the products put one (Edit stages on
  the board).
- **A record page's actions, left to right,** as Pipedrive's, HubSpot's
  and Jobber's: the ways to reach the person (Call, Email), then **More**
  (everything else: New quote, Edit, Preview, Merge, then Archive last),
  then the one next step, primary, on the right: Convert to deal, Won,
  Mark completed, Send, New invoice, Record payment. A contact has no
  next step, so no primary. A section adds its own kind at its foot ("+
  Add task", "+ New quote").
- **An archived record** says so in one line at the top of its page, with
  Unarchive beside it. Its foot is only who added it and when.
- **Home** opens with a greeting by the business's hour ("Good morning,
  Dana"; no name when all we have is an email) and the date. **Its figures**
  are one card whose cells share 1px rules (Tailwind's stats block; no icon
  tiles): the label (`text-copy` medium, `ink-2`), the figure
  (`text-display` semibold), then one `text-label` line of context. Where
  it moved, a chip leads that line: `+2` in good, `3 overdue` in late, a
  fall in neutral. Each cell links to the list behind it; all in one row
  from `lg`, two a row below, the odd one out across both. **Its lists**
  are cards: the heading with its count in a pill and a quiet link to the
  whole list, then the rows, or one centred line when there are none. They
  sit in two columns that stack on their own, so a short list never leaves
  an empty box beside a long one.
- **The leads** are a list, not a table, so a row wraps on a phone: the
  avatar, then the name, the metadata line (source, when), then what they
  said, two lines at most.
- **A row opens its record;** the work is done there, as every list in
  the four products. The one exception is a task, the work itself: its
  tick and Reschedule sit on the row. A page of rows is never a wall of
  outlined buttons.
- **Views of one list** (Open, Converted and Archived; Active and
  Archived; Mine, Everyone and Done; Day, Week and Month) are a segmented
  control (`viewsClass` and `ViewLink`): a panel track with the current
  view raised on it. **Pages of one section** (Calendar and Events;
  Invoices and Payments; Forms and Submissions) are tabs underlined in the
  accent, 14px medium (`SectionTabs`). A view filters what is here; a tab
  goes somewhere else.
- **The customers list** keeps one line per cell so every row is the same
  height: the avatar and name (the company under it), status, next task,
  email, phone, owner with their avatar, last contact. Columns drop as the
  screen narrows (phone from `2xl`, owner and last contact from `lg`, email
  from `md`); the name and status always stay.
- **The pipeline** is a row of columns on `panel`, each headed by its
  name, a count pill and its total. A card is the deal's title (medium),
  the customer (`text-label`, `ink-3`), the next task, then the value
  (semibold) with the owner's avatar on the right, as Pipedrive's cards
  are. An empty stage says "No deals here". A card moves by dragging
  (press and hold on a phone) or from the deal's stage bar; its stage
  select shows only without JavaScript. On a phone one column fills the
  screen with the next peeking in, snapping as it scrolls; the board never
  widens the page.
- **List filters** sit inline beside the search from `sm` up; on a phone
  they fold behind one Filters button that counts the ones in use. Clear
  shows as soon as anything is searched or filtered, and a filter left at
  "Any" stays out of the address, so it reads `/customers?stage=lead`.
- **Dates** drop the year in this one and the time where the day is the
  point (last contact, closed). Totals on the board and Home are
  whole units; quotes and invoices keep cents.

## Badges, chips and counts

- A **badge** is a status: `text-label` semibold, `rounded-control`, a
  tint (open strong, won the accent, lost muted; `src/admin/status.tsx`),
  never an outline that reads as a button.
- A **chip** is a change in a figure: `text-label` medium on a 10% tint of
  good or late, or panel when neutral.
- A **count** in the nav is a `rounded-full` pill: accent, or late when
  any of it is overdue. Nothing shows at zero.

## People

`Avatar` draws initials (two letters, one for an email) on the hue picked
from the name, so Dana is the same colour on every page. Size `md` (32px)
leads a row or a table's name cell; `sm` (24px) sits beside an owner's
name or alone on a card. Beside a written name it is hidden from screen
readers; alone, it takes a `label` ("Owner: Dana Ortiz") as its title and
accessible name. There are no photos: the CRM has none to show.

## Icons

Heroicons' 20px solid set, inline, from `src/views/icons.tsx`: one per nav
section, and `search`, `plus`, `menu` and `close` for the frame and
menus. `size-5` in the nav, `size-4` in a
button. An icon is always beside words or named by its button's
`aria-label`; never mix in another set.

## Buttons

Three kinds, from `src/admin/status.tsx`, never written again; all one
height (36px), so a row of them lines up with an input:

| Kind | Class | Looks | For |
|---|---|---|---|
| Primary | `primaryClass` | Filled accent | The page's one main action: New on a list, Save on a form, Won on a deal. At most one in view; an empty state under a header that already has it uses the secondary. |
| Secondary | `buttonClass` | White, a faint `line` ring and `shadow-card` | Every other action that stands alone: Call, Email, More, Lost, Edit stages, Load more. |
| Quiet | `quietClass` | No edge until pointed at, `ink-2` | An action that repeats on every row, or adds to a section: Reschedule, "+ Add task", "+ New quote" (with the plus icon). |

A button's words start with a verb or New and name the thing ("New deal",
"New quote"). **New** opens a page of its own; **Add** opens a form in
place, in a section. An icon-only button (the menu, close) has an
`aria-label`. Danger is not red: Archive is the last item under More,
with a title saying nothing is deleted, because nothing is.

## Menus

A menu is `<details data-menu>`: the summary is the button, the list
floats under it on `surface` with `shadow-lift` and a ring, each item a
full-width row that tints on hover. `static/crm.js` closes it on a click
outside and on Escape, which hands focus back to its button. The New menu,
More (`MoreMenu`), a lead's Archive (its reasons), a stage's Edit and a
task's Reschedule all work this way.

## Inputs

`controlClass` and `Select`: white, a 1px `line-strong` edge (3:1), 2px
accent on focus. A label sits above every field (`Field`); a hint under
it in `ink-3`. Search fields carry the search icon inside on the left.

## Motion

SortableJS's drag animation, Home's figures counting up once from 0
as the page opens (700ms, easing out, `crm.js`; the server's text is what
stays), and a task's circle filling as it is ticked off (`tick-pop`, 200ms,
in `styles/input.css`), where it stays struck through with Undo instead of
the page reloading, as Todoist's and HubSpot's do. Nothing else moves.
Reduced motion turns all three off.

## Words

The standard CRM words, one name per action: the `admin` skill's Words.

## Refuse

Hex values or default Tailwind colours in markup; Tailwind's default text
sizes in `src/views/` (the five tokens only); gradients, blur, glass,
gradient text; `animate-*`; tracking or leading overrides; weights above
semibold; arbitrary text sizes; a hue token used for anything but an
avatar; red for anything that is not late; a card drawn around something
that is not one thing; more than two visible actions on a list row; two
primary buttons in view; a hand-written button or input class; underlined
text standing in for a button; em dashes in interface copy.

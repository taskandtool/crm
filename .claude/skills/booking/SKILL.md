---
name: booking
description: "Appointments in the project's Postgres: weekly hours, time off, crews, the tested slot calculator, double-booking-safe booking, manage links, .ics invites, the hours editor, and the calendar sync job for Google and Microsoft. Use for any booking page, availability or calendar sync. Not for embedding Calendly."
---

# Booking

Who can be booked (`resources`, a person or a crew), when
(`availability`, `time_off`), what the calendar says is busy
(`calendars`, `busy`), and what is booked (`bookings`).
Every app granted the project database reads the same rows: the Booking app
sets the hours, the Website's booking page shows them, the CRM lists the
bookings by email.

Version: 0.1.0 (taskandtool/skills)

## The rules

- **Pages read Postgres and nothing else.** Never call a calendar from a page,
  in dev or in production. The sync job copies busy times into `busy`;
  the page reads that. So production's Worker needs only `DATABASE_URL`, never
  a calendar token, and works the same whichever calendar the owner uses.
- **Store instants, show local.** Bookings and time off are `timestamptz`.
  Weekly hours are wall times in the resource's `time_zone`. Show a booker
  times in *their* zone and name it ("Times are in Asia/Kolkata"); show the
  team times in the resource's zone. Never format a time without `timeZone`:
  dev and production both run in UTC.
- **Daylight saving, decided** (tests in `test/slots.test.ts`): days are
  walked as local dates, never by adding 24 hours. A start that the clock
  skips (02:30 on a spring-forward night) has no slot. A start that happens
  twice (01:30 on a fall-back night) is offered once, at the earlier instant.
  A window end inside a gap moves forward past it. A window never crosses
  midnight: store 22:00 to 24:00 on one day and 00:00 to 02:00 on the next.
- **Taking a booking is one non-interactive transaction** (`book.ts`): an
  advisory lock per resource as its own statement, then `insert … select …
  where not exists (overlapping booking, busy, time off) returning *`. Empty
  means taken. Do not merge the lock into the insert (the insert's snapshot
  would predate the lock and miss the booking that just committed), do not
  check in JavaScript between statements, and do not open an interactive
  transaction: the Neon HTTP driver cannot.
- **The double-booking window.** An event added to the calendar since the
  last sync is not in `busy` yet, so that time can be booked. Both
  then show in the owner's calendar. Say so if the owner asks; syncing every
  15 minutes keeps it small. Bookings never double-book each other.
- **Confirmations go through the owner's sender only.** Task & Tool sends no
  email for an app. `sendInvite` (`notify.ts`) sends through
  `data/send.ts`, configured once for the project's skills by
  `NOTIFY_FROM` and `NOTIFY_VIA` (the forms skill's "Telling the owner"). No
  sender: send nothing, and the manage page's .ics download is the invite.
- **The confirm form is spam-checked** with the forms' honeypot and minimum
  fill time (`data/spam.tsx`); set `SPAM_SECRET` so the stamp is
  signed. A bot is sent back to the day's times and nothing is booked.
- **Invites** (`ics.ts`): UID `booking-<id>@<domain>` never changes; SEQUENCE
  is `bookings.sequence`, which rises on every reschedule and cancel (clients
  ignore an update that does not raise it); REQUEST to invite by email,
  CANCEL to cancel, PUBLISH for a download. Times in UTC.
- **The manage link is the booker's key.** 32 random bytes, shown once; only
  its SHA-256 is stored and looked up. Pages that carry it send
  `Referrer-Policy: no-referrer`. A lost link cannot be recovered; the team
  can still change the booking.
- **Crews.** A crew's time is open when any member is free in their own
  hours and zone, using the crew's slot settings. The booking goes to the
  free member whose latest booking was made longest ago (never booked
  first), chosen inside the transaction.
- **Buffers.** The slot plus its before and after buffers must be clear of
  busy time and time off; two bookings are at least after + before apart.
  Buffers may fall outside the weekly hours.

Not supported: windows that cross midnight, moving a crew booking to another
member on reschedule, recurring bookings, group bookings (one booker per
slot), calendar push notifications (the job polls), Calendly or Cal.com sync.

## The calendar sync job

`sync.ts` is machine only. Each run pushes first (confirmed bookings without
an event get one, with no attendees, since Google and Microsoft would email
the booker from the owner's account; a raised SEQUENCE moves or deletes the
event), then pulls each calendar's events for the horizon and replaces that
calendar's `busy` rows in one transaction, leaving out our own events.
A failed pull keeps the old rows and writes `calendars.last_error`, which the
Calendars page shows.

**We name our events before they exist.** `bookings.event_key` is random and
filled by the column default. Its tag (`eventTag`: key, `v`, calendar row id
in hex) goes into every event: on Google as the event id `<tag>v<sequence>`
(base32hex) and a private extended property; on Microsoft as a single-value
extended property, with `<tag>v<sequence>` as the create's `transactionId`.
So a run that dies after the create finds the event by tag instead of making
a second one (a Google 409 on the id takes that event over), and the pull
leaves our events out by tag even when the id was never saved, while the
owner's own event at the same time stays busy. Do not read busy times from
Google free/busy: it merges intervals and carries no ids.

Calls go through the gateway with the machine token
(`$PHOENIX_URL/api/sprite/gateway/google-calendar/...`, `microsoft-calendar`).
Google is `events.list` with `singleEvents=true`, paged by `nextPageToken`;
free (transparent), cancelled and declined events are not busy. Microsoft is
`calendarView` with `Prefer: outlook.timezone="UTC"` and the tag `$expand`ed,
paged by `@odata.nextLink`, because `getSchedule` refuses personal accounts.
An all-day event covers its dates in the resource's zone.

Schedule it once (`/schedule-job` skill; check `list_jobs()` first), as a
command, every 15 minutes (the platform's floor), not visible to clients:

```python
schedule_job("Calendar sync", "*/15 * * * *", command="npx tsx src/booking/sync.ts", client_visible=False)
```

It exits 1 with the errors when something failed, so `job_runs` shows why.

## Files

| File | What |
|---|---|
| `schema.sql` | The seven tables and their indexes |
| `slots.ts` | The pure slot calculator, zone arithmetic, formatting for a viewer |
| `book.ts` | Open slots from the database, `book`, `reschedule`, `cancelByToken`, `setStatus` |
| `hours.ts` | The editor's writes: weekly hours, time off, settings, crews, calendars |
| `public.tsx` | `bookingPages`: day and time picker, confirm form, manage page (with the deposit's status), .ics; `onBooked`, `afterBook` |
| `admin.tsx` | `bookingAdmin` (list, detail, status, calendars) and `availabilityRoutes` (the editor) |
| `ics.ts` | RFC 5545 invite builder |
| `notify.ts` | `sendInvite`: the confirmation with its .ics, through `data/send.ts` |
| `sync.ts` | The calendar sync job (machine only) |
| `test/` | Slots and DST, concurrency, sync with a fake gateway, ICS, the pages, spam, afterBook |

## Recipes

**Add a booking page to the Website.** Copy this folder to `src/booking/`
with `data/` and `admin/` (leave `sync.ts` and its test out until a calendar
is connected: it is machine only); run `schema.sql` with `applySchema` from
the setup script. Mount
`bookingPages(getDb, { base: "/book", domain, css, source: "website", Page })`,
passing the site's own frame as `Page` (`domain` is the business's real
domain, the host of `site.url`; it names every invite, so set it once),
and under the private `/admin` path both
`bookingAdmin(getDb, { base: "/admin/bookings", css, source: "website" })`
and the editor, `availabilityRoutes(getDb, { base: "/admin/hours", css, source: "website" })`.
Make the resource with a `slug` in the editor (a POST to `/admin/hours`,
then one POST per weekly window to `/admin/hours/<id>/hours` with `weekday`,
`start`, `end`); it is booked at `/book/<slug>`. If the owner has a sender, wire `onBooked`
to `afterResponse(c, sendInvite(envOf(c), …))` with `invite({ method:
"REQUEST" })` (and CANCEL on cancel); otherwise leave it out. To take a
deposit, `afterBook` returns the Checkout URL (the payments skill's recipe).

**Let the owner change hours from another app (the CRM).** Copy `slots.ts`,
`book.ts`, `hours.ts` and `admin.tsx` and mount only
`availabilityRoutes(getDb, { base: "/hours", css, source: "crm" })` on a private path. It
writes the tables the booking page reads, so the change is live on
the next page load; nothing to sync or deploy.

**Connect a calendar.** The job calls the endpoint `google-calendar` (the
`google` connection, scope `calendar.events`) or `microsoft-calendar` (the
`microsoft` connection, `Calendars.ReadWrite`). If `list_connections()` has
neither, ask with
`request_connection("google", why="read busy times and add bookings to your calendar")`
or `request_connection("microsoft", why=…)`, give the owner the `review_url`,
and stop until it is granted; a Google owner also enables the Calendar API
on their Google Cloud project. Add the calendar on the person's page in the
editor (`primary` is the main calendar), schedule the sync job above, run it
once by hand (`npx tsx src/booking/sync.ts`) and check the Calendars page
for a sync time and no error.

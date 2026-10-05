---
name: booking
description: "Appointments in the project's Postgres: booking types (an estimate visit, a video call) with their hosts and where they happen, weekly hours, time off, the tested slot calculator, double-booking-safe booking, manage links, .ics invites, reminders, the editor, Google and Microsoft calendar sync. Use for any booking page, availability or calendar sync."
---

# Booking

What can be booked (`booking_types`: an installation, a sales visit, a
video call, each with its length, rules and where it happens), who takes
it (`booking_type_hosts`, the people in `resources`), when they can
(`availability`, `time_off`), what their calendar says is busy
(`calendars`, `busy`), and what is booked (`bookings`). Every app granted
the project database reads the same rows: the Website's `/book` pages
take bookings, the CRM sets types, hosts and hours and lists the bookings
by email.

Version: 0.3.0 (taskandtool/skills)

## The rules

- **Pages read Postgres and nothing else.** Never call a calendar from a page,
  in dev or in production. The sync job copies busy times into `busy`;
  the page reads that. So production's Worker needs only `DATABASE_URL`, never
  a calendar token, and works the same whichever calendar the owner uses.
- **Store instants, show local.** Bookings and time off are `timestamptz`.
  Weekly hours are wall times in the person's `time_zone`. Show a booker
  times in *their* zone and name it ("Times are in Asia/Kolkata"); show the
  team times in the host's zone. Never format a time without `timeZone`:
  dev and production both run in UTC.
- **Daylight saving, decided** (tests in `test/slots.test.ts`): days are
  walked as local dates, never by adding 24 hours. A start that the clock
  skips (02:30 on a spring-forward night) has no slot. A start that happens
  twice (01:30 on a fall-back night) is offered once, at the earlier instant.
  A window end inside a gap moves forward past it. A window never crosses
  midnight: store 22:00 to 24:00 on one day and 00:00 to 02:00 on the next.
- **Taking a booking is one non-interactive transaction** (`book.ts`): an
  advisory lock per candidate host as its own statement, then `insert … select …
  where not exists (overlapping booking, busy, time off) returning *`. Empty
  means taken. Do not merge the lock into the insert (the insert's snapshot
  would predate the lock and miss the booking that just committed), do not
  check in JavaScript between statements, and do not open an interactive
  transaction: the Neon HTTP driver cannot.
- **The double-booking window.** An event added to the calendar since the
  last sync is not in `busy` yet, so that time can be booked. Both
  then show in the owner's calendar. Say so if the owner asks; syncing every
  15 minutes keeps it small. Bookings never double-book each other.
- **Messages go through the owner's sender only.** Task & Tool sends no
  email for an app. The words are `bookingMessage` (`notify.ts`): booked,
  moved, cancelled, reminder, each naming what, with whom, when in the
  booker's zone and where. Delivery is a `Send`: `emailSend(env)` is email
  through `data/send.ts` (Resend or Postmark, set once by `NOTIFY_FROM`
  and `NOTIFY_VIA`, the forms skill's "Telling the owner"). No sender:
  nothing is sent and the booking stands; the manage page's .ics download
  is the invite. Another connector is another `Send` (below).
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
- **A customer books a type; a host takes it.** A type's time is open
  when any of its active hosts is free in their own hours and zone, using
  the type's rules. The booker may pick a host (`?host=`); otherwise the
  booking goes to the free host whose latest booking was made longest ago
  (never booked first), chosen inside the transaction. One person's hours
  are shared by every type they take: a booking of one closes the others.
- **Where it happens is the type's, kept on the booking.** At their place
  asks for the address; a phone call asks for the number; at ours and a
  video call carry the type's address or link. The booking stores the
  place as it was when booked, so changing a type's link or address never
  moves a booking already made. A meeting link is shown on the manage page
  and in the invite, never on the public type page.
- **Buffers.** The slot plus its before and after buffers must be clear of
  busy time and time off; two bookings are at least after + before apart.
  Buffers may fall outside the weekly hours.

Not supported: windows that cross midnight, moving a booking to another
host on reschedule, two hosts at once on one booking, recurring bookings,
group bookings (one booker per slot), a meeting link made per booking (the
type's link is shared), a manage link in a reminder (only its hash is
stored), calendar push notifications (the job polls), Calendly or Cal.com
sync.

## Messages and reminders

Wire the confirmation once, where bookings are taken:

```ts
onBooked: (c, e) => afterResponse(c, notifyBooking(emailSend(envOf(c)), e, { domain })),
```

It sends the booked, moved or cancelled message with the calendar invite
(REQUEST, or CANCEL with a higher SEQUENCE) when the host has an email.
`bookingAdmin`'s `onBooked` does the same for a booking the team makes.

**Reminders** are a job on the machine (`reminders.ts`), a day and an hour
before by default. Schedule it once (`/schedule-job`; check `list_jobs()`
first), every 15 minutes, not visible to clients:

```python
schedule_job("Booking reminders", "*/15 * * * *", command="npx tsx src/booking/reminders.ts", client_visible=False)
```

`--before 1440,120` changes the times. Each reminder is claimed in
`booking_reminders` before it is sent, so it goes once; a moved booking is
reminded again; only the nearest due reminder goes; none for a booking
made after the reminder's time. With no sender each is recorded as
`none`, so connecting one later reminds from then on.

**The last mile is the owner's connection.** Email is Resend or Postmark
(`list_connections()`; ask with `request_connection("resend", why=…)` if
neither is granted), then `NOTIFY_FROM` on a domain verified there. For a
text instead, or as well, write a `Send` against the owner's Twilio
connection through the gateway (the `connections` skill) and pass it to
`notifyBooking` and `sendReminders`; the words and the once-only rules stay
the same. Never send through an address of Task & Tool's.

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
An all-day event covers its dates in the person's zone.

Schedule it once (`/schedule-job` skill; check `list_jobs()` first), as a
command, every 15 minutes (the platform's floor), not visible to clients:

```python
schedule_job("Calendar sync", "*/15 * * * *", command="npx tsx src/booking/sync.ts", client_visible=False)
```

It exits 1 with the errors when something failed, so `job_runs` shows why.

## Files

| File | What |
|---|---|
| `schema.sql` | The nine tables and their indexes |
| `slots.ts` | The pure slot calculator, zone arithmetic, formatting for a viewer |
| `book.ts` | Types and hosts, open slots from the database, `book`, `reschedule`, `cancelByToken`, `setStatus` |
| `hours.ts` | The editor's writes: types and their hosts, people, weekly hours, time off, calendars |
| `public.tsx` | `bookingPages`: what can be booked, host, day and time, confirm form, manage page (with the deposit's status), .ics; `onBooked`, `afterBook` |
| `admin.tsx` | `bookingAdmin` (list, detail, status, Schedule, Book for someone, calendars), `typeRoutes` and `peopleRoutes` (the editor) |
| `ics.ts` | RFC 5545 invite builder |
| `notify.ts` | The words (`bookingMessage`), `notifyBooking`, `emailSend` and the `Send` type |
| `reminders.ts` | The reminder job (machine only) |
| `sync.ts` | The calendar sync job (machine only) |
| `test/` | Slots and DST, concurrency, sync with a fake gateway, ICS, the pages, spam, afterBook |

## Recipes

**Add a booking page to the Website.** Copy this folder to `src/booking/`
with `data/` and `admin/` (leave `sync.ts` and its test out until a calendar
is connected: it is machine only); run `schema.sql` with `applySchema` from
the setup script. Mount
`bookingPages(getDb, { base: "/book", domain, css, source: "website", Page })`,
passing the site's own frame as `Page` (`domain` is the business's real
domain, the host of `site.url`; it names every invite, so set it once).
`/book` lists what can be booked and `/book/<slug>` books one; link the nav
to `/book`. If the owner has a sender, wire `onBooked` to
`afterResponse(c, notifyBooking(emailSend(envOf(c)), e, { domain }))`
(Messages and reminders, above); otherwise leave it out. To
take a deposit, `afterBook` returns the Checkout URL (the payments skill's
recipe). The types, people and hours are the team's: in the CRM when the
project has one (below), else `bookingAdmin` under the Website's private
`/admin/bookings`.

**Set up what can be booked.** Ask what people book, how long it takes,
where it happens and who does it, then add the people (`/people`: name,
email for the invite, time zone, weekly hours), then each type (`/types`:
a name like "Installation estimate", its address `install-estimate`, the
length, a buffer for travel or set-up, notice, where it happens) and tick
who takes it. A type no active person takes is left off `/book`.

**The team's side in another app (the CRM).** Mount `bookingAdmin(getDb,
{ base: "/bookings", css, source: "crm", Frame, extra, timeZone,
manageBase, onBooked })` on its private routes: the list of bookings, the
Schedule (a week of bookings and time off, by person), Book for someone
(`/new`, which takes `name`, `email`, `phone` and `address` in its link so
a team member starting from a customer types nothing twice), the types and
their hosts, each person's hours, time off and calendars. `Frame` puts the
pages in the app's own layout (the booking sections become links at the
top); `extra` adds to a booking's page (the CRM's customer and "Make it a
job"); `timeZone` is the Schedule's; `manageBase` is the Website's `/book`
address, so a team booking's confirmation carries a manage link; `onBooked`
sends it. It writes the tables the Website's `/book` reads, so a change is
live on the next page load; nothing to sync or deploy.

**Connect a calendar.** The job calls the endpoint `google-calendar` (the
`google` connection, scope `calendar.events`) or `microsoft-calendar` (the
`microsoft` connection, `Calendars.ReadWrite`). If `list_connections()` has
neither, ask with
`request_connection("google", why="read busy times and add bookings to your calendar")`
or `request_connection("microsoft", why=…)`, give the owner the `review_url`,
and stop until it is granted; a Google owner also enables the Calendar API
on their Google Cloud project. Add the calendar on the person's page in the
editor (People and hours) (`primary` is the main calendar), schedule the sync job above, run it
once by hand (`npx tsx src/booking/sync.ts`) and check the Calendars page
for a sync time and no error.

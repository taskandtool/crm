---
name: booking
description: "Appointments in the project's Postgres: booking types with their hosts, hours and time off, the tested slot calculator, double-booking-safe booking, a time and its price inside a form, manage links, invites, reminders, calendar sync. Use for a booking page, availability, hours or calendars. Not for the form around a booking (forms)."
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

Version: 0.4.0 (taskandtool/skills)

## The rules

- **Pages read Postgres and nothing else.** Never call a calendar from a page,
  in dev or in production. The sync job copies busy times into `busy`;
  the page reads that. So production's Worker needs only `DATABASE_URL`, never
  a calendar token, and works the same whichever calendar the owner uses.
- **The jobs are the CRM's.** Calendar sync and reminders run there;
  other apps book into the same tables and mount `bookingAdmin` with
  `calendars: false`. No CRM, no sync or reminders: offer it.
- **Store instants, show local.** Bookings and time off are `timestamptz`.
  Weekly hours are wall times in the person's `time_zone`. Show a booker
  times in *their* zone and name it ("Times are in Asia/Kolkata"); show the
  team times in the host's zone. Never format a time without `timeZone`:
  dev and production both run in UTC.
- **Changing `slots.ts`, `book.ts` or `ics.ts`:** read `references/internals.md`
  first (daylight saving, the booking transaction, invites, the manage link);
  `npm test` holds them.
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
  is the invite. Another connector is another `Send` (`references/messages.md`).
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

## A time inside a form, and a paid booking

A form's `booking` step (`bookingStep(getDb, { source })` in
`form-step.tsx`) books the person the questions named; the booking names
the submission (`submission_id`), the payment step charges the type's
`price_cents`, and it is confirmed when the form is complete (`confirm.ts`). The
time is held 45 minutes (`hold_until`); `releaseLapsedHolds`, run before
times are listed or taken, cancels it only when the form is not complete and
no payment was started or its checkout expired, and the form then sends them back to pick again
(`stillValid`). How the three link: the payments skill's "Submissions,
bookings and payments".

## Files

| File | What |
|---|---|
| `schema.sql` | The nine tables and their indexes |
| `slots.ts` | The pure slot calculator, zone arithmetic, formatting for a viewer |
| `book.ts` | Types and hosts, open slots from the database, `book`, `reschedule`, `cancelByToken`, `setStatus`, `releaseLapsedHolds` |
| `form-step.tsx` | `bookingStep`: a form's booking step |
| `hours.ts` | The editor's writes: types and their hosts, people, weekly hours, time off, calendars |
| `confirm.ts` | `confirmFormBooking`: a form's booking confirmed once, on the form completing |
| `public.tsx` | `bookingPages`: what can be booked, a time, confirm, the manage page and .ics; `onBooked`, `afterBook` |
| `admin.tsx` | `bookingAdmin`: bookings, Schedule, Book for someone, the editor, calendars |
| `ics.ts` | RFC 5545 invite builder |
| `notify.ts` | The words (`bookingMessage`), `notifyBooking`, `emailSend` and the `Send` type |
| `reminders.ts` | `sendReminders`: claims and sends the reminders due now |
| `reminders-job.ts` | The reminder job's command (machine only) |
| `sync.ts` | The calendar sync job (machine only) |
| `test/` | Slots and DST, concurrency, sync with a fake gateway, ICS, the pages, spam, afterBook |

## Read next

| When | Read |
|---|---|
| Confirmations, reminders, a text instead of an email | `references/messages.md` |
| Changing the slot maths, the booking transaction, invites or the manage link | `references/internals.md` |
| Connecting a calendar, the sync job, busy times | `references/calendar-sync.md` |
| A booking page on the Website, setting up types and people, the team's side in the CRM | `references/recipes.md` |

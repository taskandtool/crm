---
name: booking
description: "Appointments: booking types with hosts, hours and time off, tested slots, double-booking-safe booking, a time and its price inside a form, manage links, invites, reminders, calendar sync. Use for a booking page, availability, hours, appointments or calendars. Not for the form around a booking (forms)."
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

## The rules

- **Pages read Postgres for busy times.** A page never reads a calendar
  while someone waits: the sync job copies busy times into `busy`, and the
  page reads that. A booking a page writes goes to the calendar after the
  response (`pushAfterWrites`), through the app's connections, which hold
  no token in the app, in dev or production.
- **The jobs are the CRM's.** Calendar sync and reminders run there
  (`jobs.ts`, as job routes); other apps book into the same tables, mount
  `bookingAdmin` with `calendars: false` and `pushAfterWrites`. Without the CRM in the project there is no sync and no
  reminders: offer the owner the CRM Starter App.
- **Store instants, show local.** Bookings and time off are `timestamptz`.
  Weekly hours are wall times in the person's `time_zone`. Show a booker
  times in *their* zone and name it ("Times are in Asia/Kolkata"); show the
  team times in the host's zone. Never format a time without `timeZone`:
  dev and production both run in UTC.
- **Changing `slots.ts`, `book.ts` or `ics.ts`:** each file's header says
  what is decided and why; `npm test` holds it.
- **The double-booking window.** An event added to the calendar since the
  last sync is not in `busy` yet, so that time can be booked. The event
  and the booking then both show in the owner's calendar. Say so if the owner asks; syncing every
  15 minutes keeps it small. Bookings never double-book each other.
- **A booker is a customer** from the moment they book: `takeSlot` saves
  them through the customers skill (`savePerson`), a visit at their place
  giving their address.
- **A booker's own changes are noted.** A move or cancel through their
  manage link writes a `booking_changes` row in the same statement, so the
  CRM's notifications show what the team did not do. The team's changes are not
  noted there.
- **One appointment table.** `bookings` also holds what the team schedules
  itself (the CRM's events): such a row may have no service (`title` names
  it), nobody assigned yet, or no email. Read it with `left join` to
  `booking_types` and `resources`. Reminders and invites go only to a
  booking with a service, someone taking it and an email.
- **Messages** are `bookingMessage`'s words (`notify.ts`) through a `Send`;
  `emailSend(env)` is the app's sender (`data/send.ts`). A booker needs
  Resend or Postmark: Task & Tool email reaches only the team. No sender
  for them: nothing is sent, the booking stands, and the
  manage page's .ics is the invite. A text instead: `references/messages.md`.
- **A customer books a type; a host takes it.** A type's time is open
  when any of its active hosts is free in their own hours and zone, using
  the type's rules. The booker may pick a host (`?host=`); otherwise the
  booking goes to the free host whose latest booking was made longest ago
  (a host never booked goes first), chosen inside the transaction. One person's hours
  are shared by every type they take: a booking of one closes the others.
- **Where it happens is the type's, kept on the booking.** A type at their
  place asks for the address; a phone call asks for the number; a type at
  ours or a video call carries the type's address or link. The booking stores the
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
`price_cents`, and the booking is confirmed when the form is complete
(`confirm.ts`). The time is held for 45 minutes (`hold_until`): until the
form is complete the booking is the visitor's, so it keeps its time but is
on no team list (the Schedule, an app's events) except its submission.
`releaseLapsedHolds` runs before times are listed or taken. It cancels a
held booking only when the form is not complete and either no payment was
started or its checkout expired; the form then sends the person back to
pick a time again (`stillValid`). How the three link: the payments skill's "Submissions,
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
| `admin.tsx` | `bookingAdmin`: the Schedule (a week, by person), Book for someone, a booking's reschedule, cancel, completed and no-show; `typeRoutes`: Services (what each is, who takes it); `peopleRoutes`: Team (each person's hours, time off, calendars) |
| `ics.ts` | RFC 5545 invite builder |
| `notify.ts` | `bookingMessage` (the words), `notifyBooking`, `emailSend`/`emailSender`, the `Send` type, `runOnBooked`, `noticeFor` (a move or cancel made away from the booking pages, to tell the booker of), `sendInvite` (your own words with the invite) |
| `reminders.ts` | `sendReminders`: claims and sends the reminders due now |
| `calendars.ts` | The connected calendar accounts: `linkAccounts`, `findCalendars` (what each account can see), the gateway call |
| `sync.ts` | The calendar sync: `pushBookings`, then pull busy times; `pushAfterWrites`: a booking reaches its calendar after the write that changed it |
| `jobs.ts` | `bookingJobs`: the routes `/jobs/calendar-sync` and `/jobs/booking-reminders` |
| `test/` | Slots and DST, concurrency, sync and finding calendars with a fake gateway, ICS, the pages, spam, afterBook |

## Read next

| When | Read |
|---|---|
| Confirmations, reminders, a text instead of an email | `references/messages.md` |
| Connecting a calendar, the sync job, busy times | `references/calendar-sync.md` |
| A booking page on the Website, setting up types and people, the team's side in the CRM | `references/recipes.md` |

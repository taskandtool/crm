---
name: booking
description: "Books appointments: booking types with hosts, hours and time off, tested slots, double-booking-safe booking, a time and its price inside a form, manage links, invites, reminders and calendar sync. Use for a booking page, availability, hours, appointments or calendars. Not for the form around a booking (forms)."
---

# Booking

What can be booked (`booking_types`: an installation, a sales visit, a
video call, each with its length, rules and where it happens), who takes
it (`booking_type_hosts`, the people in `resources`), when they can
(`availability`, `time_off`), what their calendar says is busy
(`calendars`, `busy`), and what is booked (`bookings`). Every app granted
the project database reads the same rows. Visitors book on the Website's
`/book` pages. In the CRM the team sets types, hosts and hours, and the
bookings are listed by email.

## The rules

- **Pages read Postgres for busy times.** A page never reads a calendar
  while someone waits: the sync job copies busy times into `busy`, and the
  page reads that. A booking, new or changed, goes to the calendar after the response (`pushAfterWrites`). The push goes through the app's connections; the
  app holds no token, in dev or production.
- **The jobs are the CRM's.** Calendar sync and reminders are job routes
  in the CRM (`jobs.ts`). Other apps book into the same tables and mount
  `bookingAdmin` with `calendars: false`, plus `pushAfterWrites`. A project
  without the CRM has no sync and no reminders: offer the owner the CRM
  Starter App.
- **Store instants, show local.** Bookings and time off are `timestamptz`.
  Weekly hours are wall times in the person's `time_zone`. Show a booker
  times in *their* browser's zone and name it once ("Times are in
  Kolkata"). Show the team times in their own browser's zone
  (`admin/viewer.tsx`). Weekly hours and time off stay in the host's zone.
  A message has no browser: it uses the booker's saved zone, else the host's. Never format a
  time without `timeZone`: dev and production both run in UTC.
- **Changing `slots.ts`, `book.ts` or `ics.ts`:** each file's header has
  what is decided and why, and `npm test` checks those decisions.
- **The double-booking window.** An event added to the calendar since the
  last sync is not in `busy` yet. Someone can book that time, and the event
  and the booking then both show in the owner's calendar. Tell the owner if
  they ask. With a sync every 15 minutes the window is short. A host's bookings never overlap.
- **A booker is a customer** from the moment they book: `takeSlot` saves
  them with the customers skill's `savePerson`. For a visit at their place
  it saves their address too.
- **A booker's own changes are noted.** A move or cancel through their
  manage link writes a `booking_changes` row in the same statement. The
  CRM's notifications list these rows: the changes the team did not make.
  The team's changes are not noted there.
- **One appointment table.** `bookings` also holds what the team schedules
  itself (the CRM's events). Such a row may have no service (its `title`
  is the name), nobody assigned yet, or no email. Read it with `left join` to
  `booking_types` and `resources`. Reminders and invites go only to a
  booking with a service, someone taking it and an email.
- **Messages** are `bookingMessage`'s words (`notify.ts`) sent through a
  `Send`. `emailSend(env)` is the app's sender (`data/send.ts`). Email to a
  booker needs Resend or Postmark, because Task & Tool email goes only to
  the team. Without either, nothing is sent and the booking still stands;
  the .ics on the manage page is the invite. A text instead:
  `references/messages.md`.
- **A customer books a type; a host takes it.** A time is open for a type
  when any of its active hosts is free in their own hours and zone, under
  the type's rules. The booker may pick a host (`?host=`). Otherwise the
  booking goes to the free host whose latest booking was made longest ago
  (a host never booked goes first); the choice is made inside the
  transaction. A person has one set of hours for every type they take, and
  booking one type closes that time for the others.
- **Where it happens is set on the type and copied to the booking.** A type at
  the customer's place asks for the address, and a phone call asks for the
  number. A type at ours or a video call carries the type's address or
  link. The booking stores the place as it was when booked. Changing a
  type's link or address later leaves existing bookings as they are. A meeting link is shown on the manage page and in the invite, never on the public type page.
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
`form-step.tsx`) books the person the form's questions named. The booking
records the submission (`submission_id`), the payment step charges the
type's `price_cents`, and `confirm.ts` confirms the booking when the form
is complete. The time is held for 45 minutes (`hold_until`). Until the
form is complete the booking keeps its time but appears on no team list
(the Schedule, an app's events), only on its submission.

`releaseLapsedHolds` runs before times are listed or taken. It cancels a
held booking only when the form is not complete and either no payment was
started or its checkout expired. The visitor is then sent back to pick a
time again (`stillValid`). How submissions, bookings and payments link:
the payments skill's "Submissions, bookings and payments".

The thanks page has the time (`thanks`), found through the draft's key in
its address. On the manage page one tap changes nothing: a booker asks to
move or cancel, then confirms.

## Files

| File | What |
|---|---|
| `schema.sql` | The tables and their indexes |
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
| `jobs.ts` | `bookingJobs`: the routes `/_jobs/calendar-sync` and `/_jobs/booking-reminders` |
| `test/` | Slots and DST, concurrency, sync and finding calendars with a fake gateway, ICS, the pages, spam, afterBook |

## Read next

| When | Read |
|---|---|
| Confirmations, reminders, a text instead of an email | `references/messages.md` |
| Connecting a calendar, the sync job, busy times | `references/calendar-sync.md` |
| A booking page on the Website, setting up types and people, the team's side in the CRM | `references/recipes.md` |

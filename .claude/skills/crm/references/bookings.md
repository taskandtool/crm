# Bookings in the CRM

Read when setting up what can be booked, who takes it, their hours and calendars, booking messages, or "Make it a job".

## Bookings

A customer books a **type** (an estimate visit, an installation, a video
call) and one of its **hosts** takes it. Here, under Bookings, the team
sets what can be booked (`/bookings/types`: length, buffers for travel,
notice, and where it happens, whether at their place, at ours, by phone or
by video link), who takes each, each person's weekly hours, time off and Google or
Outlook calendar (`/bookings/people`), and sees every booking. The public
page that takes bookings is the Website's (`/book`, the booking skill's
recipe): this CRM is private as a whole and never shows a booking page.
The CRM and that page read and write the same tables, so a change here is
live there on the next load.

Set it up by asking what people book, how long it takes, where it
happens and who does it; add the people first, then the types, and tick
who takes each. A type nobody takes stays off `/book`.

The Schedule shows the week by person. Book for someone books a caller
in, as does "Book a time" on a customer's page, which carries their
details.

**Messages.** A booking the team makes sends its confirmation, and the
reminder job reminds every booker a day and an hour before. Both go through
the owner's email sender, which needs Resend or Postmark granted to this app (if
`python3 ~/tools/taskandtool.py list-connections` shows neither, ask with
`python3 ~/tools/taskandtool.py request-connection resend --why "send booking confirmations and reminders"`),
`NOTIFY_FROM` set to an address on a domain verified there, and
`NOTIFY_VIA` when the connection's slug is not the vendor's name. With
no sender, nothing is sent and the bookings stand. Schedule the reminders once,
if `python3 ~/tools/taskandtool.py list-jobs` does not show them:
`python3 ~/tools/taskandtool.py schedule-job "Booking reminders" --when "*/15 * * * *" --command "npx tsx src/booking/reminders-job.ts"`. A text message instead
is a `Send` written against the owner's Twilio connection (the `booking`
skill's "Messages and reminders"). Never send through Task & Tool.

A booking is a time on someone's calendar; a job is the record of the
work. "Make it a job" (on the booking, on the customer's page, or in the
Jobs page's "Booked, not a job yet") adds the customer if they are new
(their address from a booking at their place) and a job carrying the
booking's type, time, host and place, once per booking.

Calendars, reminders and the booking skill's other rules are in the
`booking` skill; the calendar sync job is `src/booking/sync.ts` (schedule
it as that skill says, with `npx tsx src/booking/sync.ts`).

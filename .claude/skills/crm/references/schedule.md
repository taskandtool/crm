# The schedule

Read when putting something on the schedule, setting up what can be booked online, the Team's hours and calendars, or booking messages.

## Events

Every appointment, job or visit is one **event** (`events` in the config
names them: Event, Job, Appointment). Each is a row in the booking
skill's `bookings`, whether a customer made it on the Website's booking
page or the team did. There is nothing to convert. An event has when (a start and a
length), what (a title, or the service booked), who takes it (a Team
member, or nobody yet), where, a status (scheduled, then completed,
no-show or cancelled; never deleted), an amount, notes, and the config's
`events.fields`. An online booking belongs to the customer its email (else
phone) matches; one held for a form still being paid is not an event until
it is paid.

`node scripts/events.mjs add <who> "<what>" --at "friday 9:30" --host Dana`
puts one on the schedule (`--deal <id>` for one of their deals; `--help` for
the rest); `done`, `no-show` and `cancel` change it; a completed one counts
as contact. Pages: `/schedule` (the calendar), `/events` (upcoming,
overdue, past, all; CSV), each event's page, and a section on every customer's page and every
deal's (its own events). Converting a lead from an online booking moves
its booking onto the new deal.

## Online booking

With `booking` on, customers book a **service** (an estimate visit, an
installation, a video call) on the Website's `/book` page and one of the
Team who takes it is booked. Under Settings the team sets the Services
(`/services`: length, gaps for travel, notice, where it happens) and
who takes each, and each person's weekly hours, time off and Google or
Outlook calendar (Team, `/team`). The booking page reads the same tables;
a change shows there on the next load. Set it up by asking what people
book, how long it takes, where and who does it: add the people first, then
the services.

**Messages.** An online booker gets a confirmation, and the reminder job
reminds them a day and an hour before (only for a booking of a service,
with someone taking it, to someone with an email). They are also told
when someone moves or cancels the event on its page or with `events.mjs`
(which says whether they were told). These emails need the owner's
Resend or Postmark: Task & Tool email reaches only the team. With
no sender, nothing is sent. To set up the sender and schedule the
reminders job once, read the `booking` skill's `references/messages.md`.
Texts are in the `phone` skill. Once Twilio approves the business number,
the confirmation and the day-before text also go from it
(`node scripts/phone.mjs flows`).

Calendars, their sync job and the booking skill's other rules are in the
`booking` skill.

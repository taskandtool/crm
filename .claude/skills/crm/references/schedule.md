# The schedule

Read when putting something on the schedule, setting up what can be booked online, the Team's hours and calendars, or booking messages.

## Events

Every appointment, job or visit is one **event** (`events` in the config
names them: Event, Job, Appointment), a row in the booking skill's
`bookings`, whoever made it: a customer on the Website's booking page, or
the team. There is nothing to convert. An event has when (a start and a
length), what (a title, or the service booked), who takes it (a Team
member, or nobody yet), where, a status (scheduled, then completed,
no-show or cancelled; never deleted), an amount, notes, and the config's
`events.fields`. An online booking belongs to the customer its email (else
phone) matches; one held for a form still being paid is not an event until
it is paid.

`node scripts/events.mjs add <who> "<what>" --at "friday 9:30" --host Dana`
puts one on the schedule (`--deal <id>` for one of their deals; `--help` for
the rest); `done`, `no-show` and `cancel` change it; a completed one counts
as contact. Pages: `/events` (upcoming, overdue (scheduled, time passed, not marked), past, all;
CSV), each event's page, and a section on every customer's page and every
deal's (its own events). A lead from an online booking, converted, takes
its booking onto the new deal.

## Online booking

With `booking` on, customers book a **service** (an estimate visit, an
installation, a video call) on the Website's `/book` page and one of the
Team who takes it is booked. Under Schedule the team sets the Services
(`/services`: length, gaps for travel, notice, where it happens) and
who takes each, and each person's weekly hours, time off and Google or
Outlook calendar (Team, `/team`). This CRM is private and never
shows a booking page; both read the same tables, so a change is live there
on the next load. Set it up by asking what people book, how long it takes,
where and who does it: add the people first, then the services.

**Messages.** An online booker gets a confirmation, and the reminder job
reminds them a day and an hour before (only for a booking of a service,
with someone taking it, to someone with an email). A move or a cancel
tells them too, from wherever it is made: the event's page or
`events.mjs` (which says whether they were told). All go through the owner's email sender, which needs
Resend or Postmark granted to this app (if
`python3 ~/tools/taskandtool.py list-connections` shows neither, ask with
`python3 ~/tools/taskandtool.py request-connection resend --why "send booking confirmations and reminders"`),
`NOTIFY_FROM` on a domain verified there, and `NOTIFY_VIA` when the
connection's slug is not the vendor's name. With no sender nothing is sent.
Schedule the reminders once, if `python3 ~/tools/taskandtool.py list-jobs`
does not show them:
`python3 ~/tools/taskandtool.py schedule-job "Booking reminders" --when "*/15 * * * *" --command "npx tsx src/booking/reminders-job.ts"`.
A text message instead is a `Send` written against the owner's Twilio
connection (the `booking` skill's "Messages and reminders"). Never send
through Task & Tool.

Calendars and the booking skill's other rules are in the `booking` skill;
the calendar sync job is `src/booking/sync.ts` (schedule it as that skill
says, with `npx tsx src/booking/sync.ts`).

# Messages and reminders

Read when setting up booking confirmations, reminders, or a text instead of an email.

Wire the confirmation once, where bookings are taken:

```ts
onBooked: (c, e) => afterResponse(c, notifyBooking(emailSend(envOf(c)), e, { domain })),
```

`notifyBooking` sends the booked, moved or cancelled message with the
calendar invite (REQUEST, or CANCEL with a higher SEQUENCE) when the host
has an email. `bookingAdmin`'s `onBooked` does the same for a booking the
team makes.

A booking made inside a form is confirmed when the form is complete
(`confirm.ts`): wire `confirmFormBooking` into the forms routes'
`onComplete` and the payments webhook's `afterPaid` (that file's header
shows both). `confirmFormBooking` claims the booking first. The message goes once, from
whichever app and hook gets there first. An app with no sender leaves the
booking for an app that has one.

**Reminders** are the CRM's job route `/_jobs/booking-reminders`
(`bookingJobs` in `jobs.ts`; the sending is in `reminders.ts`). By default
they go a day and an hour before. Schedule the job once with the
`schedule-job` skill, every 15 minutes and not visible to clients:

```bash
python3 ~/tools/taskandtool.py schedule-job "Booking reminders" --when "*/15 * * * *" --route /_jobs/booking-reminders
```

`bookingJobs(getDb, { before: [1440, 120] })` changes the times. The job
answers with what was sent and what was left alone, and a 500 when a send failed. Each reminder is claimed in `booking_reminders` before it is sent,
and goes once (`reminders.ts` lists which go). With no sender each is
recorded as `none`.

**Email to a booker goes through the owner's Resend or Postmark**,
because Task & Tool email goes only to the team. Check with
`python3 ~/tools/taskandtool.py list-connections`. If neither is granted,
ask with `python3 ~/tools/taskandtool.py request-connection resend --why "…"`.
Then set `NOTIFY_FROM` on a domain verified there. Texts are the `phone`
skill's: its Booked and Looking forward texts go from the business number
alongside these emails. They have their own once-only claims. Call its
`onBooked` from the same `onBooked`.

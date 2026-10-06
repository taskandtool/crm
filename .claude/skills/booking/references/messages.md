# Messages and reminders

Read when setting up booking confirmations, reminders, or a text instead of an email.

Wire the confirmation once, where bookings are taken:

```ts
onBooked: (c, e) => afterResponse(c, notifyBooking(emailSend(envOf(c)), e, { domain })),
```

It sends the booked, moved or cancelled message with the calendar invite
(REQUEST, or CANCEL with a higher SEQUENCE) when the host has an email.
`bookingAdmin`'s `onBooked` does the same for a booking the team makes.

A booking made inside a form is confirmed when the form is complete
(`confirm.ts`): wire `confirmFormBooking` into the forms routes'
`onComplete` and the payments webhook's `afterPaid` (that file's header
shows both). It claims the booking first, so it sends once whichever app
and delivery get there; one with no sender leaves it for one that has.

**Reminders** are a job on the CRM's machine (`reminders-job.ts`, the command;
`reminders.ts`, the sending), a day and an hour before by default.
Schedule it once (`/schedule-job`; check `list_jobs()` first), every 15
minutes, not visible to clients:

```python
schedule_job("Booking reminders", "*/15 * * * *", command="npx tsx src/booking/reminders-job.ts", client_visible=False)
```

`--before 1440,120` changes the times; it prints what was sent and what was
left alone, and exits 1 when a send failed. Each reminder is claimed in
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

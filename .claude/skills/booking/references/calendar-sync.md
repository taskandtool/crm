# The calendar sync job

Read when connecting a Google or Outlook calendar, scheduling the sync, or when busy times look wrong.

`sync.ts` is the sync, run as the app's job route `/_jobs/calendar-sync`
(`jobs.ts`). Each run pushes first, then pulls. The push adds an event
for each confirmed booking that has none. The event has no attendees,
because Google and Microsoft would email the booker from the owner's
account. A raised SEQUENCE moves or deletes the event. The pull fetches
each calendar's events for the horizon and replaces that calendar's `busy`
rows in one transaction. It leaves out our own events.

When the team moves a booking to another person, the next push deletes
its event from the first person's calendar and forgets that calendar. The
push after adds it to the new person's calendar, like any booking with no
event. A failed pull keeps the old rows and writes `calendars.last_error`.
The error shows on the person's page under Team and is flagged in the
Team list.

Because our events carry a tag (`eventTag`, `sync.ts`), a run that dies after
creating an event never makes a second one, and the pull leaves ours out
by the tag.
Never read busy times from Google free/busy: it merges intervals and
carries no ids.

Each person connects their own Google or Microsoft in Task & Tool, and the
app holds each under its own slug: the first `google-calendar`, a second
person's `google-calendar-7c2e1a`. Each run first lists them into
`calendar_accounts` (`listConnections`). The first time the job sees an account, it gives that account's main calendar to the person whose email it is (`linkAccounts`, `calendars.ts`). An account someone removed stays removed.

Pressing Show available calendars on a person's page (Team) asks every
held account for the calendars it can read (Google `calendarList`,
Microsoft `/me/calendars`; `findCalendars`). Each calendar is listed once,
with every account that can reach it. Attach stores the account
(`connection`), the calendar's id and name, and whether that account can
add events there (`receives_bookings`). A calendar the account can only
read gives busy times and takes no bookings. One account that the team
shares its calendars with covers everyone. Each person connecting their
own works too. Free/busy access alone is not enough, because the pull
reads events.

Every calendar call, the lookup included, goes through the app's
connections (`gatewayFetch`) to the row's connection, from the team
address or production alike. Google is `events.list` with `singleEvents=true`, paged by `nextPageToken`;
free (transparent), cancelled and declined events are not busy. Microsoft is
`calendarView` with `Prefer: outlook.timezone="UTC"` and the tag `$expand`ed,
paged by `@odata.nextLink`, because `getSchedule` refuses personal accounts.
An all-day event covers its dates in the person's zone.

Only the app that owns the calendars (the CRM) mounts the job. The job
links accounts first, and `linkAccounts` drops the ones the calling app
does not hold. Add `app.route("/", bookingJobs(getDb))` to its `app.tsx`,
ahead of the team gate. Then schedule it once with the `schedule-job`
skill, every 15 minutes and not visible to clients:

```bash
python3 ~/tools/taskandtool.py schedule-job "Calendar sync" --when "*/15 * * * *" --route /_jobs/calendar-sync
```

Once the app is deployed the job runs in production and wakes no
machine. Before that it runs on the dev server. When something fails the job
answers 500 with the errors, and `list-job-runs` shows them.

**A booking reaches the calendar at once.** Mount `pushAfterWrites`
(`sync.ts`) first in `app.tsx`. After every successful write it pushes to the calendars whose connection the app holds; the job above pushes the
rest. An app that takes bookings for the CRM's calendars (the Website)
pushes at once if the owner grants it the same calendar connections.
Without them its bookings reach the calendar on the CRM's next sync.

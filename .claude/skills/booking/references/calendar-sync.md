# The calendar sync job

Read when connecting a Google or Outlook calendar, scheduling the sync, or when busy times look wrong.

`sync.ts` is machine only. Each run pushes first, then pulls. The push
gives each confirmed booking without an event one, with no attendees
(Google and Microsoft would email the booker from the owner's account), and
a raised SEQUENCE moves or deletes the event. The pull fetches each
calendar's events for the horizon and replaces that calendar's `busy` rows
in one transaction, leaving out our own events.
A failed pull keeps the old rows and writes `calendars.last_error`, which the
Calendars page shows.

**We name our events before they exist.** `bookings.event_key` is random and
filled by the column default. Its tag (`eventTag`: key, `v`, calendar row id
in hex) goes into every event: on Google as the event id `<tag>v<sequence>`
(base32hex) and a private extended property; on Microsoft as a single-value
extended property, with `<tag>v<sequence>` as the create's `transactionId`.
So a run that dies after the create finds the event by tag instead of making
a second one (a Google 409 on the id takes that event over). The pull
leaves our events out by tag even when the id was never saved, while the
owner's own event at the same time stays busy. Do not read busy times from
Google free/busy: it merges intervals and carries no ids.

Calls go through the gateway with the machine token
(`$PHOENIX_URL/api/machine/gateway/google-calendar/...`, `microsoft-calendar`).
Google is `events.list` with `singleEvents=true`, paged by `nextPageToken`;
free (transparent), cancelled and declined events are not busy. Microsoft is
`calendarView` with `Prefer: outlook.timezone="UTC"` and the tag `$expand`ed,
paged by `@odata.nextLink`, because `getSchedule` refuses personal accounts.
An all-day event covers its dates in the person's zone.

Schedule it once (the `schedule-job` skill; check `python3 ~/tools/taskandtool.py list-jobs` first), as a
command, every 15 minutes (the platform's floor), not visible to clients:

```bash
python3 ~/tools/taskandtool.py schedule-job "Calendar sync" --when "*/15 * * * *" --command "npx tsx src/booking/sync.ts" --team-only
```

It exits 1 with the errors when something failed, so `job-runs` shows why.

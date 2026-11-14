# Recipes

Read for the request each paragraph names: a booking page on the Website, setting up what can be booked, the team's side, connecting a calendar.

**A booking page on the Website.** The Website has it mounted
(`src/business.tsx`). `/book` lists what can be booked, and `/book/<slug>`
books one, confirmed through `onBooked`. A form's `booking` step books
inside a form, confirmed when the form is complete (`confirm.ts`). The
Schedule, services and team are under the private `/admin/schedule`,
`/admin/services` and `/admin/team` (`calendars: false`). Link the nav to
`/book`.

In another app, copy this folder to `src/booking/` with `data/` and
`admin/`. Leave out `jobs.ts`, `reminders.ts` and their tests, because the
jobs are the CRM's, and mount `pushAfterWrites` from `sync.ts`. Run
`schema.sql` with `applySchema` from the setup script, and mount
`app.route("/book", bookingPages(getDb, { base: "/book", domain, css, source, Page, onBooked }))`.
Pass the site's own frame as `Page` and `onBooked` as in
`references/messages.md`. `domain` is the host of the site's address and
names every invite; set it once. With the payments skill, `afterBook`
returns the Checkout URL for a deposit (see its recipe). Bookings made
here reach the hosts' calendars on the CRM's next sync, within 15
minutes. To send them at once, offer the owner to grant this app the
calendar connections the CRM holds (`request-connection google --why "put
bookings in your calendar the moment they are made"`).

**Set up what can be booked.** Ask what people book, how long it takes,
where it happens and who does it, then add the people (Team: name,
email for the invite, time zone, weekly hours), then each type (Services:
a name like "Installation estimate", its address `install-estimate`, the
length, a buffer for travel or set-up, notice, where it happens) and tick
who takes it. A type no active person takes is left off `/book`.

**The team's side in any app.** Mount `bookingAdmin` (the Schedule; Book
for someone at `/new`, which takes `name`, `email`, `phone` and `address` in
its link; a booking's Reschedule, Cancel, Completed and No-show, each told to
the booker through `onBooked`), `typeRoutes` (Services) and `peopleRoutes`
(Team) on the private routes, each given `sections` so they link to one
another. Every other option is documented on `BookingAdminOptions` in
`admin.tsx`. A booking with no page in the app opens on its Reschedule
page, and it can be cancelled there too. Every app writes the tables
`/book` reads, and a change shows on the next page load.

**Connect a calendar** (in the CRM, which runs the sync). Each person who
wants one connects their own Google (`google` connection, scopes
`calendar.events` and `calendar.calendarlist.readonly`) or Microsoft
(`microsoft`, `Calendars.ReadWrite` and `Calendars.ReadWrite.Shared`); the
app holds each under its own slug (`google-calendar`, `google-calendar-7c2e1a`).
One account a team shares calendars with is enough too. If
`python3 ~/tools/taskandtool.py list-connections` shows none, ask with
`python3 ~/tools/taskandtool.py request-connection google --why "read busy times and add bookings to your calendar"`
(or `microsoft`), give the owner the review link, and stop until it is
granted. A Google owner also enables the Calendar API on their Google
Cloud project. Schedule the sync job (`references/calendar-sync.md`) and
run it once from the app's Jobs tab. The first run gives each connected
account to the person on Team whose email it is. For anyone else, the
owner opens that person's page under Team, presses Show available
calendars and attaches one. Then check their Calendars for a sync time and
no error. A person with no calendar is scheduled from their hours alone.

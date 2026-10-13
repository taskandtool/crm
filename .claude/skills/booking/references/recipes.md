# Recipes

Read for the request each paragraph names: a booking page on the Website, setting up what can be booked, the team's side, connecting a calendar.

**A booking page on the Website.** The Website has it mounted
(`src/business.tsx`): `/book` lists what can be booked and `/book/<slug>`
books one (confirmed through `onBooked`), a form's `booking` step books
inside a form (confirmed when the form is complete, `confirm.ts`), and
the Schedule, services and team are under its private
`/admin/schedule`, `/admin/services` and `/admin/team` (`calendars: false`). Link the nav to `/book`. In another
app, copy this folder to `src/booking/` with `data/` and `admin/` (leave
out `sync.ts`, `reminders-job.ts` and their tests: they are the CRM's),
run `schema.sql` with `applySchema` from the setup script, and mount
`app.route("/book", bookingPages(getDb, { base: "/book", domain, css, source, Page, onBooked }))`
with the site's own frame as `Page` (`domain`, the host of the site's
address, names every invite, so set it once) and `onBooked` as in
`references/messages.md`. With the payments skill, `afterBook` returns the
Checkout URL to take a deposit (its recipe).

**Set up what can be booked.** Ask what people book, how long it takes,
where it happens and who does it, then add the people (Team: name,
email for the invite, time zone, weekly hours), then each type (Services:
a name like "Installation estimate", its address `install-estimate`, the
length, a buffer for travel or set-up, notice, where it happens) and tick
who takes it. A type no active person takes is left off `/book`.

**The team's side in any app.** Mount the three route sets on its private
routes, each given every section's address (`sections`) so one links to
another: `bookingAdmin` (the Schedule, a week of bookings and time off by
person; Book for someone at `/new`, which takes `name`, `email`, `phone`
and `address` in its link so a team member starting from a customer types
nothing twice; a booking's Reschedule, Cancel, Completed and No-show, each
told to the booker through `onBooked`), `typeRoutes` (Services: the types
and who takes each) and `peopleRoutes` (Team: each person's hours, time
off and, where the app runs the sync, calendars). `Frame` puts the pages in
the app's own layout. `returnTo` sends every link to a booking to the
app's own page for it (the Website's submission, the CRM's event), and
Reschedule and Cancel come back there; one it has no page for opens on
its Reschedule, which can cancel it too; `afterStatus` runs after a status
change; `scheduleActions` replaces Book for someone (the CRM's New event);
`timeZone` is the Schedule's; `manageBase` is the Website's `/book`
address, so a team booking's confirmation carries a manage link. Every app
writes the tables the Website's `/book` reads, so a change is live on the
next page load; nothing to sync or deploy.

**Connect a calendar** (in the CRM, which runs the sync). The job calls the endpoint `google-calendar` (the
`google` connection, scope `calendar.events`) or `microsoft-calendar` (the
`microsoft` connection, `Calendars.ReadWrite`). If `python3 ~/tools/taskandtool.py list-connections` shows
neither, ask with
`python3 ~/tools/taskandtool.py request-connection google --why "read busy times and add bookings to your calendar"`
(or `microsoft`), give the owner the review link,
and stop until it is granted; a Google owner also enables the Calendar API
on their Google Cloud project. Add the calendar on the person's page under
Team (`primary` is the main calendar), schedule the sync job (`references/calendar-sync.md`), run it
once by hand (`npx tsx src/booking/sync.ts`) and check that page's Calendars
for a sync time and no error.

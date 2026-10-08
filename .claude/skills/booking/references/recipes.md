# Recipes

Read for the request each paragraph names: a booking page on the Website, setting up what can be booked, the team's side in the CRM, connecting a calendar.

**A booking page on the Website.** The Website has it mounted
(`src/business.tsx`): `/book` lists what can be booked and `/book/<slug>`
books one (confirmed through `onBooked`), a form's `booking` step books
inside a form (confirmed when the form is complete, `confirm.ts`), and
the types, people and hours are under its private
`/admin/bookings` (`calendars: false`). Link the nav to `/book`. In another
app, copy this folder to `src/booking/` with `data/` and `admin/` (leave
out `sync.ts`, `reminders-job.ts` and their tests: they are the CRM's),
run `schema.sql` with `applySchema` from the setup script, and mount
`app.route("/book", bookingPages(getDb, { base: "/book", domain, css, source, Page, onBooked }))`
with the site's own frame as `Page` (`domain`, the host of the site's
address, names every invite, so set it once) and `onBooked` as in
`references/messages.md`. With the payments skill, `afterBook` returns the
Checkout URL to take a deposit (its recipe).

**Set up what can be booked.** Ask what people book, how long it takes,
where it happens and who does it, then add the people (`/people`: name,
email for the invite, time zone, weekly hours), then each type (`/types`:
a name like "Installation estimate", its address `install-estimate`, the
length, a buffer for travel or set-up, notice, where it happens) and tick
who takes it. A type no active person takes is left off `/book`.

**The team's side in another app (the CRM).** Mount `bookingAdmin(getDb,
{ base: "/bookings", css, source: "crm", Frame, extra, timeZone,
manageBase, onBooked })` on its private routes: the list of bookings, the
Schedule (a week of bookings and time off, by person), Book for someone
(`/new`, which takes `name`, `email`, `phone` and `address` in its link so
a team member starting from a customer types nothing twice), the types and
their hosts, each person's hours, time off and calendars. `Frame` puts the
pages in the app's own layout (the booking sections become links at the
top); `extra` adds to a booking's page (the CRM's customer and "Make it a
job"); `timeZone` is the Schedule's; `manageBase` is the Website's `/book`
address, so a team booking's confirmation carries a manage link; `onBooked`
sends it. It writes the tables the Website's `/book` reads, so a change is
live on the next page load; nothing to sync or deploy.

**Connect a calendar** (in the CRM, which runs the sync). The job calls the endpoint `google-calendar` (the
`google` connection, scope `calendar.events`) or `microsoft-calendar` (the
`microsoft` connection, `Calendars.ReadWrite`). If `python3 ~/tools/taskandtool.py list-connections` shows
neither, ask with
`python3 ~/tools/taskandtool.py request-connection google --why "read busy times and add bookings to your calendar"`
(or `microsoft`), give the owner the review link,
and stop until it is granted; a Google owner also enables the Calendar API
on their Google Cloud project. Add the calendar on the person's page in the
editor's People and hours (`primary` is the main calendar), schedule the sync job (`references/calendar-sync.md`), run it
once by hand (`npx tsx src/booking/sync.ts`) and check the Calendars page
for a sync time and no error.

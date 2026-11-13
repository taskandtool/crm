# CRM

**A CRM for leads, deals, proposals and invoices that your AI agent sets up
and runs by chat.** You get a record of everyone who got in touch, a deals
board, and quotes your customers sign and pay online.

[![Deploy on Task & Tool](https://taskandtool.com/images/deploy-button.svg)](https://taskandtool.com/accounts/register?starter_app=crm)

![Nora's Home in Northline Gardens' CRM, with a signed backyard proposal over it](https://taskandtool.com/images/starter-apps/crm.webp)

It's made to run on Task & Tool. There, each app has its own computer for
your AI agent. The project has a Postgres database. The agent uses the
skills and scripts in this repo to add contacts, move deals, write proposals
and send invoices when you ask in the chat. The CRM is built with Hono, htmx
and Tailwind.

## Get started

Click the button above, or pick CRM when you create an app on [Task &
Tool](https://taskandtool.com/starter-apps/crm). Then ask the agent to set
up the CRM for your business.

See it in use on the [CRM page](https://taskandtool.com/starter-apps/crm).

## Features

### You turn leads into deals and drag them across your stages

A form fill or an online booking becomes a lead as it comes in. You add
phone calls and walk-ins with New lead. Convert a good lead into a deal, or
archive it with a reason. On the deals board you drag deals between the
stages you named. A card has the deal's value and its next task. A column
has its count and total. On a phone you press and hold a card to drag it, or
change the stage on the deal's page.

### Your team sees this week's numbers on Home

At the top are new leads in the last 7 days against the 7 before, your tasks
due, the open deals, what you won this month and what you're owed. Below
them are the newest leads, today's schedule, your tasks due and the deals
closing this month. Under the bell you see what customers did on their own:
a booker who moved or cancelled, a proposal signed or declined, a payment.

![Northline Gardens' Home in the CRM: six new leads in 7 days, four tasks due, $25,960 in open deals, $10,657 won this month and $1,560 owed](https://taskandtool.com/images/marketing/northline-gardens-crm-home.webp)

### Someone who gets in touch twice has one record

They are matched by email, or by phone when there's no email. A contact's
page has their tasks, a timeline of notes, calls, quotes and payments, their
deals and their invoices. You can search contacts, leads, deals, quotes and
invoices from any page. Filter contacts by status, tag or owner, export the
list as CSV, and merge two records of one person. You can archive a contact.
The CRM has no way to delete one.

### The agent writes proposals from your website

The agent reads your website. Once Google Places is connected, it reads your
Google listing too. Then it writes the proposal's sections in your words and with
your photographs. You tick the sections a quote should have: Cover photo,
Letter, About us, How we'll do it, Full-width photo, Our work, Our team,
Reviews, Clients, Questions and Terms.

Every proposal has the price, tax and total.

<p>
  <img src="https://taskandtool.com/images/marketing/northline-gardens-crm-proposal-cover.webp" width="300" alt="The cover of a backyard redesign proposal for Grace Okafor, over a photo of her garden">
  <img src="https://taskandtool.com/images/marketing/northline-gardens-crm-proposal-signed.webp" width="300" alt="The signed proposal: Grace Okafor signed on October 9, and invoice HDTLW5D9-0001 for $2,580.00 is paid">
</p>

### Customers sign quotes online and pay by card through your Stripe account

You email a quote as a private link through your Resend or Postmark account.
You can also copy the link and send it yourself. The customer types their
name to accept, or says why not. You see when they opened it. You can attach
a deposit invoice to a quote. The customer gets it with a Pay now button
when they sign. Stripe emails the invoice from your account and takes the
payment. You can record a full or part payment made in cash or by check.
Once a customer has paid by card, you can charge that saved card next time.
You can bill a customer on the dates you set, by email or on their saved
card.

### Your team plans visits and jobs on a shared calendar

The calendar has the events your team adds and the bookings customers make
on the Website Starter App's booking page. You can view a day, a week or a
month, for everyone or one person. Under Settings you set what customers can
book, and everyone's hours and time off. Anyone on the team can connect a
Google or Microsoft calendar. The agent schedules a sync every 15 minutes.
Your bookings appear on that calendar. Times marked busy there can't be
booked.

![The day's schedule by person: Ana Silva's lawn care and fall cleanup, Marco Ferrara's patio laying and Nora Quinn's garden visit](https://taskandtool.com/images/marketing/northline-gardens-crm-schedule.webp)

### Each person gets a morning email of their tasks

At 7:00 in the business's time zone, everyone with something due gets one
email. It has their overdue tasks, today's tasks, their proposals a customer
opened since yesterday, and how many leads came in. When a proposal is still
unsigned after 3 days, whoever made it gets a follow-up task.

### You can add a business phone number from Twilio

You connect your Twilio account and choose a business number. Calls to that
number ring your phone. Anyone whose call you miss can get a text back. Your
team can text customers from the CRM. You can switch on and reword seven
automatic texts. Two of them are a booking confirmation and a reminder.
Texts start once Twilio approves your US texting registration. Calls work
from the first day.

### The agent imports your contacts from a spreadsheet

Attach a CSV or an Excel file in the chat. The agent shows you a dry run
first. The agent matches each row to an existing contact by email, then
phone. For a match it fills only empty fields and adds tags. A person on
three rows becomes one contact.

### You tell the agent your stages and fields

The agent reads what it already knows about the business, asks what it can't
tell, and writes `crm.config.json`. That file holds what you call a contact
(Patients, Guests, Clients), the statuses, the deal stages, your custom
fields and the time zone. `examples/` has five worked setups: a two-van HVAC
shop, a dental practice, a restaurant with events, a plumber with three
locations and eight trucks, and a counselor.

### Skills in this repo

A skill is a set of instructions for one kind of work. The agent loads one
when a task needs it:

| Skill | What it does |
|---|---|
| `crm` | Leads, contacts, deals, tasks, the schedule, proposals and setting the CRM up |
| `invoices` | Quotes, invoices, recurring invoices and saved cards |
| `booking` | What customers can book, hours, reminders and calendar sync |
| `phone` | The business number, missed-call texts and the automatic texts |
| `forms` `payments` `reports` | Form submissions, Stripe payments and refunds, the lead report |
| `brand` | Facts, photographs and the look of the business from its site |
| `writing` `tropes` | Writing in the owner's voice and the check for phrases that read as AI |
| `customers` `data` `admin` | The shared contact records, email sending, the team's lists |

The agent runs scripts for common actions like adding a contact or sending
an invoice. All of them have a `--help`. The agent sends to a customer or
merges two contacts only when you tell it to.

## Why run it on Task & Tool

Task & Tool is the easiest place to run it. The database the CRM needs is
included. The agent sets up the scheduled jobs. Each app gets:

- Its own computer for the agent
- A dev address where your team uses the CRM
- A Postgres database for contacts, deals and invoices that you can roll
  back to an earlier point in time. The Website Starter App in the same
  project uses this database too. A booking there is already a lead here.
- Publishing on your own domain with a free SSL certificate. Only your team
  can open the CRM. You decide when customers can open proposal links.
- Connections to Stripe, Google and Microsoft calendars, Twilio and email.
  Task & Tool holds their keys.
- Scheduled jobs for the morning email, recurring invoices, texts, reminders
  and calendar sync
- Sign-in for your team. The CRM has no login of its own.

## Make it your own

Ask the agent for any change in the chat. To start from your own copy, fork
this repo, change what you like, and start a new app from your fork on Task
& Tool. You can also copy its skills from `.claude/skills/` into another
repo.

## What's in the repo

```
crm.config.json   your words, statuses, deal stages, fields and time zone
schema.sql        the CRM's tables
src/              the app: pages, routes and the business code
src/proposals/    the proposal page and its sections
examples/         five worked setups for different businesses
scripts/          what the agent runs: contacts, deals, tasks, quotes, invoices
styles/ static/   the design tokens, the built CSS and the browser scripts
test/             the tests
.claude/skills/   the 13 skills
AGENTS.md         what the agent reads first
DESIGN.md         the design tokens explained
.taskandtool/     setup for an install on Task & Tool
starter-app.json  what the app needs and its chat suggestions
```

## Commands

The agent runs these on the app's computer. With Node 20 or later and a
Postgres database, you can run the CRM on your own computer too. Run `npm
install` and set `DATABASE_URL` to your database. Set `ADMIN_DEV_USER` to
your email to sign in as yourself.

- `npm run dev` serves the CRM on localhost:3000. It rebuilds the CSS and
  restarts the server whenever a file changes.
- `npm run check` runs the checks: the config and examples, the design
  rules, the AI-tells scan and the typecheck. `npm test` runs the tests. The
  database tests run when `TEST_DATABASE_URL` is set and skip without it.
- `npm run deploy` applies the schema, builds the CRM and publishes it to
  production. It works only on Task & Tool.

## Third-party tools

- [`tt-crawl`](https://github.com/taskandtool/crawler), our crawler, and the
  browsers it reads sites with. The agent uses it for the proposal's words
  and photos.
- Pillow, for sizing photographs.
- Schibsted Grotesk, the CRM's typeface (SIL Open Font License,
  `static/fonts/`).
- npm packages, MIT: `hono`, `@hono/node-server`, `pg`, `tailwindcss` +
  `@tailwindcss/cli`, `esbuild`, `tsx`, `sortablejs`; `htmx.org` (0BSD) and
  `typescript` (Apache-2.0).

## Contributing

Pull requests are welcome. The repo holds no credentials. We run a secret
scan before each push.

## License

MIT. See `LICENSE`.

// The document around every page: head, the header with the CRM's sections
// and who is signed in, then the page. Scripts are the vendored htmx and
// crm.js on every page, and SortableJS only where something drags.
import type { Child } from "hono/jsx";
import { SectionTabs } from "../admin/layout";
import { dealsCfg, invoicesCfg, showBooking, visitsCfg, vocab } from "../config";

export type Section = "inbox" | "tasks" | "deals" | "customers" | "schedule" | "forms" | "invoices" | "stages";

/**
 * Schedule, as Jobber's and Housecall Pro's: one place for the team's days.
 * The Calendar (bookings and jobs together) first, then each list, then what
 * can be booked and who takes it. Only the parts this CRM has.
 */
export const SCHEDULE_TABS = [
  ...(showBooking ? [{ href: "/bookings/calendar", label: "Calendar" }] : []),
  ...(visitsCfg ? [{ href: "/visits", label: visitsCfg.many }] : []),
  ...(showBooking ? [
    { href: "/bookings", label: "Bookings" },
    { href: "/bookings/types", label: "Services" },
    { href: "/bookings/people", label: "Team" },
  ] : []),
];

/** The Schedule's tabs on a page of its own (the jobs list); the booking pages draw theirs. */
export function ScheduleTabs({ current }: { current: string }) {
  return SCHEDULE_TABS.length > 1 ? <SectionTabs label="Schedule" links={SCHEDULE_TABS} current={current} /> : null;
}

export function Layout(props: {
  title: string;
  user: string;
  section: Section;
  drag?: boolean;
  wide?: boolean;
  /** The list this page belongs to, shown above the title. */
  back?: { href: string; label: string };
  /** A line under the title: who it is for, how to reach them. */
  sub?: Child;
  /** The page's own actions, beside the title; at most one primary. */
  actions?: Child;
  children?: Child;
}) {
  const { title, user, section, drag, wide, back, sub, actions, children } = props;
  // The daily work, in the order it happens (as Jobber's menu runs: clients,
  // requests, the schedule, invoices); Forms and Stages are set up once and
  // sit to the right, quieter.
  const nav: { href: string; label: string; section: Section }[] = [
    { href: "/", label: "Inbox", section: "inbox" },
    { href: "/tasks", label: "Tasks", section: "tasks" },
    { href: "/customers", label: vocab.many, section: "customers" },
    { href: "/deals", label: dealsCfg.many, section: "deals" },
    ...(SCHEDULE_TABS.length ? [{ href: SCHEDULE_TABS[0].href, label: "Schedule", section: "schedule" as const }] : []),
    ...(invoicesCfg ? [{ href: "/invoices", label: "Invoices", section: "invoices" as const }] : []),
  ];
  const setup: { href: string; label: string; section: Section }[] = [
    { href: "/forms", label: "Forms", section: "forms" },
    { href: "/stages", label: "Stages", section: "stages" },
  ];
  const link = (n: { href: string; label: string; section: Section }, quiet = false) => (
    <a
      href={n.href}
      aria-current={section === n.section ? "page" : undefined}
      class={"shrink-0 rounded-control px-2 py-1 no-underline " + (section === n.section ? "bg-panel font-semibold" : (quiet ? "text-label text-ink-3" : "text-ink-2") + " hover:bg-canvas hover:text-ink")}
    >
      {n.label}
      {/* How many tasks of mine are due, and what is in the Inbox's To do: filled in after the page loads so no page waits on them. */}
      {n.section === "tasks" ? <span hx-get="/tasks/count" hx-trigger="load" hx-swap="outerHTML"></span> : null}
      {n.section === "inbox" ? <span hx-get="/inbox/count" hx-trigger="load" hx-swap="outerHTML"></span> : null}
    </a>
  );
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{title}</title>
        <link rel="stylesheet" href="/crm.css" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <script src="/vendor/htmx.min.js" defer></script>
        {/* Before the first paint: a card's stage select, there for a browser without JavaScript, steps aside where cards drag. */}
        {drag ? <script dangerouslySetInnerHTML={{ __html: 'document.documentElement.classList.add("js")' }}></script> : null}
        {drag ? <script src="/vendor/Sortable.min.js" defer></script> : null}
        <script src="/crm.js" defer></script>
      </head>
      <body class="min-h-screen bg-canvas font-body text-copy text-ink">
        <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-control focus:bg-accent focus:px-3 focus:py-1 focus:text-accent-ink">
          Skip to content
        </a>
        <header class="border-b border-line bg-surface">
          {/* One row: it scrolls sideways on a phone rather than wrapping. */}
          {/* The same width as the page below, so the nav and the title line up. */}
          <div class={"mx-auto flex min-w-0 items-center gap-1 overflow-x-auto px-4 py-2 " + (wide ? "max-w-7xl" : "max-w-6xl")}>
            <nav aria-label="CRM" class="flex items-center gap-1">
              {nav.map((n) => link(n))}
            </nav>
            <nav aria-label="Setup" class="ml-auto flex items-center gap-1 pl-4">
              {setup.map((n) => link(n, true))}
              <span class="hidden max-w-56 truncate pl-2 text-label text-ink-3 lg:inline" title="Signed in through Task & Tool">
                {user}
              </span>
            </nav>
          </div>
        </header>
        <main id="main" class={"mx-auto px-4 py-5 " + (wide ? "max-w-7xl" : "max-w-6xl")}>
          {back ? (
            <p class="mb-1 text-label">
              <a href={back.href} class="text-ink-2">{back.label}</a>
            </p>
          ) : null}
          <div class="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div class="min-w-0">
              <h1 class="text-title font-semibold">{title}</h1>
              {sub ? <div class="mt-1 text-ink-2">{sub}</div> : null}
            </div>
            {actions ? <div class="flex flex-wrap items-center gap-2">{actions}</div> : null}
          </div>
          {children}
        </main>
      </body>
    </html>
  );
}

/** Shown to a team member while the database is not ready yet. Refreshes itself. */
export function WaitingView({ state, error }: { state: string; error: string }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta http-equiv="refresh" content="5" />
        <title>CRM</title>
        <link rel="stylesheet" href="/crm.css" />
      </head>
      <body class="min-h-screen bg-canvas p-8 font-body text-copy text-ink">
        <h1 class="text-title font-semibold">The CRM is waiting for its database</h1>
        <p class="mt-2 max-w-xl text-ink-2">
          {state === "no-url"
            ? "The project's database is not connected yet. On Task & Tool it is being set up, or can be added from the app's page, and this page refreshes on its own. Off Task & Tool, put a Postgres connection string in .env as DATABASE_URL (see .env.example)."
            : state === "error"
              ? `The database did not answer yet: ${error}. Retrying.`
              : "Connecting and setting up the tables."}
        </p>
      </body>
    </html>
  );
}

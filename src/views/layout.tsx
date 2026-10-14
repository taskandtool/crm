// The document around every page: head, the sidebar (search, New, the CRM's
// sections, Setup, who is signed in; a drawer below lg), then the page. Scripts are the vendored htmx and
// crm.js on every page, and SortableJS only where something drags.
import type { Child } from "hono/jsx";
import { SectionTabs } from "../admin/layout";
import { dealsCfg, eventsCfg, invoicesCfg, showBooking, vocab } from "../config";
import { Icon } from "./icons";
import { inputClass } from "../admin/status";
import { Avatar, buttonClass } from "./ui";

/** The New menu: everything that can be made, each its own page. */
const creates = [
  { href: "/leads/new", label: "Lead" },
  { href: "/customers/new", label: vocab.one },
  { href: "/deals/new", label: dealsCfg.one },
  { href: "/tasks/new", label: "Task" },
  ...(eventsCfg ? [{ href: "/events/new", label: eventsCfg.one }] : []),
  ...(invoicesCfg ? [{ href: "/invoices/quotes/new", label: "Quote" }, { href: "/invoices/new", label: "Invoice" }] : []),
];

/** The sidebar's name: the business on its quotes once it has one, else what this is. */
const brand = invoicesCfg?.name && !/to fill/i.test(invoicesCfg.name) ? invoicesCfg.name : "CRM";

export type Section = "home" | "notifications" | "leads" | "tasks" | "deals" | "customers" | "schedule" | "forms" | "invoices";

/**
 * Schedule, as Jobber's and Housecall Pro's: one place for the team's days.
 * The Calendar (every event) first, then each list, then what
 * can be booked and who takes it. Only the parts this CRM has.
 */
export const SCHEDULE_TABS = eventsCfg
  ? [
      { href: "/schedule", label: "Calendar" },
      { href: "/events", label: eventsCfg.many },
      ...(showBooking ? [{ href: "/services", label: "Services" }] : []),
      { href: "/team", label: "Team" },
    ]
  : [];

/** The Schedule's tabs on a page of its own (the events list); the booking pages draw theirs. */
export function ScheduleTabs({ current }: { current: string }) {
  return SCHEDULE_TABS.length > 1 ? <SectionTabs label="Schedule" links={SCHEDULE_TABS} current={current} /> : null;
}

export function Layout(props: {
  title: string;
  /** The page's heading when it is not its title (Home's greeting). */
  heading?: string;
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
  const { title, heading, user, section, drag, wide, back, sub, actions, children } = props;
  // The daily work, in the order it happens (as Jobber's menu runs: clients,
  // requests, the schedule, invoices); Setup sits at the sidebar's foot, as
  // settings do in Catalyst and Linear. The stages are edited from the board
  // they shape, as Pipedrive's Edit pipeline.
  const nav: { href: string; label: string; section: Section }[] = [
    { href: "/", label: "Home", section: "home" },
    { href: "/leads", label: "Leads", section: "leads" },
    { href: "/tasks", label: "Tasks", section: "tasks" },
    { href: "/customers", label: vocab.many, section: "customers" },
    { href: "/deals", label: dealsCfg.many, section: "deals" },
    ...(SCHEDULE_TABS.length ? [{ href: SCHEDULE_TABS[0].href, label: "Schedule", section: "schedule" as const }] : []),
    ...(invoicesCfg ? [{ href: "/invoices", label: "Invoices", section: "invoices" as const }] : []),
  ];
  const setup: { href: string; label: string; section: Section }[] = [
    { href: "/forms", label: "Forms", section: "forms" },
  ];
  const link = (n: { href: string; label: string; section: Section }) => {
    const on = section === n.section;
    return (
      <a
        href={n.href}
        aria-current={on ? "page" : undefined}
        class={"flex items-center gap-2.5 rounded-control px-2.5 py-2 font-medium no-underline " +
          (on ? "bg-surface text-ink shadow-card ring-1 ring-line" : "text-ink-2 hover:bg-surface/60 hover:text-ink")}
      >
        <Icon name={n.section} class={"size-5 " + (on ? "text-ink" : "text-ink-3")} />
        {n.label}
        {/* How many tasks of mine are due and how many leads are open: filled in after the page loads so no page waits on them. */}
        {n.section === "tasks" ? <span hx-get="/tasks/count" hx-trigger="load" hx-swap="outerHTML"></span> : null}
        {n.section === "leads" ? <span hx-get="/leads/count" hx-trigger="load" hx-swap="outerHTML"></span> : null}
      </a>
    );
  };
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
        {/* Below lg: a bar with the menu button, as Catalyst's and Tailwind Plus's sidebar layouts have it.
            The button opens the sidebar below as a drawer: crm.js does it, and without JavaScript the
            link's #nav does it through :target. */}
        <header data-nav-inert class="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface px-4 lg:hidden">
          <a href="#nav" data-nav-open aria-label="Open the menu" aria-controls="nav" aria-expanded="false"
            class="-ml-1.5 inline-flex size-9 items-center justify-center rounded-control text-ink-2 hover:bg-panel hover:text-ink">
            <Icon name="menu" />
          </a>
          <span class="min-w-0 flex-1 truncate font-semibold">{brand}</span>
          <Bell on={section === "notifications"} />
        </header>
        {/* The sidebar: fixed from lg up; below, a drawer over the page. */}
        <aside id="nav" aria-label="Menu"
          class="peer fixed inset-y-0 left-0 z-40 hidden w-72 flex-col overflow-y-auto bg-canvas px-3 pb-3 shadow-lift target:flex lg:flex lg:w-60 lg:shadow-none [.nav-open_&]:flex">
          <div class="flex items-center justify-between gap-2 px-2 pt-4 pb-3">
            <span class="min-w-0 flex-1 truncate text-heading font-semibold">{brand}</span>
            <span class="hidden lg:contents"><Bell on={section === "notifications"} /></span>
            <a href="#" data-nav-close aria-label="Close the menu" class="inline-flex size-9 items-center justify-center rounded-control text-ink-2 hover:bg-panel hover:text-ink lg:hidden">
              <Icon name="close" />
            </a>
          </div>
          {/* Search from any page, as HubSpot's and Pipedrive's top search: it opens the customers list filtered. "/" focuses it (crm.js). */}
          <form method="get" action="/customers" role="search" class="relative">
            <label>
              <span class="sr-only">Search {vocab.many.toLowerCase()}</span>
              <Icon name="search" class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-3" />
              <input type="search" name="q" data-search placeholder={`Search ${vocab.many.toLowerCase()}`} autocomplete="off"
                class={inputClass + " pr-8 pl-8"} />
              <kbd aria-hidden="true" class="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded-control px-1.5 text-label text-ink-3 ring-1 ring-line lg:block">/</kbd>
            </label>
          </form>
          {/* Create from anywhere, as HubSpot's Create and Pipedrive's + menus. */}
          <details data-menu class="relative mt-3">
            <summary class={buttonClass + " w-full cursor-pointer list-none"}>
              <Icon name="plus" class="size-4 text-ink-3" />New
            </summary>
            <div class="absolute inset-x-0 z-10 mt-1 rounded-control bg-surface p-1 shadow-lift ring-1 ring-line">
              {creates.map((c) => (
                <a href={c.href} class="block rounded-control px-2.5 py-1.5 font-medium text-ink no-underline hover:bg-panel">{c.label}</a>
              ))}
            </div>
          </details>
          <nav aria-label="CRM" class="mt-4 flex flex-col gap-0.5">
            {nav.map((n) => link(n))}
          </nav>
          <nav aria-label="Setup" class="mt-auto flex flex-col gap-0.5 pt-8">
            <p class="px-2.5 pb-1 text-label font-medium text-ink-3">Setup</p>
            {setup.map((n) => link(n))}
          </nav>
          <p class="mt-3 flex items-center gap-2.5 border-t border-line px-2.5 pt-4" title="Signed in through Task & Tool">
            <Avatar name={user} />
            <span class="min-w-0 truncate text-ink-2">{user}</span>
          </p>
        </aside>
        {/* Behind an open drawer: a click on it closes the drawer. */}
        <a href="#" data-nav-close tabindex={-1} aria-hidden="true" class="fixed inset-0 z-30 hidden bg-ink/30 peer-target:block lg:hidden [.nav-open_&]:block"></a>
        <div data-nav-inert class="lg:pl-60">
          {/* The page: one white panel, edge to edge on a phone, inset on the canvas from lg up. */}
          <main id="main" class="min-h-[calc(100vh-3.5rem)] bg-surface lg:m-2 lg:ml-0 lg:min-h-[calc(100vh-1rem)] lg:rounded-card lg:shadow-card lg:ring-1 lg:ring-line">
            <div class={"mx-auto px-4 py-6 sm:px-6 lg:px-10 lg:py-10 " + (wide ? "" : "max-w-6xl")}>
              {back ? (
                <p class="mb-2 text-label">
                  <a href={back.href} class="text-ink-3 no-underline hover:text-ink">← {back.label}</a>
                </p>
              ) : null}
              <div class="mb-8 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
                <div class="min-w-0">
                  <h1 class="text-title font-semibold">{heading ?? title}</h1>
                  {sub ? <div class="mt-1 text-ink-2">{sub}</div> : null}
                </div>
                {actions ? <div class="flex flex-wrap items-center gap-2">{actions}</div> : null}
              </div>
              {children}
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}

/** The bell beside the business's name: the notifications page, with how many are unread. One shows at a time (the bar's below lg, the sidebar's from lg up). */
function Bell({ on }: { on: boolean }) {
  return (
    <a href="/notifications" aria-current={on ? "page" : undefined}
      class={"relative inline-flex size-9 items-center justify-center rounded-control hover:bg-panel hover:text-ink " + (on ? "bg-panel text-ink" : "text-ink-2")}>
      <Icon name="notifications" />
      <span class="sr-only">Notifications</span>
      {/* Filled in once it shows, so no page waits on it and the hidden one asks nothing. */}
      <span hx-get="/notifications/count" hx-trigger="intersect once" hx-swap="outerHTML"></span>
    </a>
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

// The document around every page: head, the header with the CRM's sections
// and who is signed in, then the page. Scripts are the vendored htmx and
// crm.js on every page, and SortableJS only where something drags.
import type { Child } from "hono/jsx";
import { dealsCfg, invoicesCfg, showBooking, visitsCfg, vocab } from "../config";

export type Section = "inbox" | "follow-ups" | "deals" | "customers" | "visits" | "bookings" | "forms" | "invoices" | "stages";

export function Layout(props: { title: string; user: string; section: Section; drag?: boolean; wide?: boolean; children?: Child }) {
  const { title, user, section, drag, wide, children } = props;
  const nav: { href: string; label: string; section: Section }[] = [
    { href: "/", label: "What came in", section: "inbox" },
    { href: "/follow-ups", label: "Follow-ups", section: "follow-ups" },
    { href: "/deals", label: dealsCfg.many, section: "deals" },
    { href: "/customers", label: vocab.many, section: "customers" },
    ...(visitsCfg ? [{ href: "/visits", label: visitsCfg.many, section: "visits" as const }] : []),
    ...(showBooking ? [{ href: "/bookings", label: "Bookings", section: "bookings" as const }] : []),
    { href: "/forms/submissions", label: "Forms", section: "forms" },
    ...(invoicesCfg ? [{ href: "/invoices", label: "Invoices", section: "invoices" as const }] : []),
    { href: "/stages", label: "Stages", section: "stages" },
  ];
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
        {drag ? <script src="/vendor/Sortable.min.js" defer></script> : null}
        <script src="/crm.js" defer></script>
      </head>
      <body class="min-h-screen bg-canvas font-body text-copy text-ink">
        <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-control focus:bg-accent focus:px-3 focus:py-1 focus:text-accent-ink">
          Skip to content
        </a>
        <header class="border-b border-line bg-surface">
          <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
            <nav aria-label="CRM" class="flex flex-wrap items-center gap-1">
              {nav.map((n) => (
                <a
                  href={n.href}
                  aria-current={section === n.section ? "page" : undefined}
                  class={"rounded-control px-2 py-1 no-underline " + (section === n.section ? "bg-panel font-semibold" : "text-ink-2 hover:bg-panel")}
                >
                  {n.label}
                  {/* How many of mine are due, filled in after the page loads so no page waits on it. */}
                  {n.section === "follow-ups" ? <span hx-get="/follow-ups/count" hx-trigger="load" hx-swap="outerHTML"></span> : null}
                </a>
              ))}
            </nav>
            <span class="ml-auto hidden max-w-56 truncate text-label text-ink-3 sm:inline" title="Signed in through Task & Tool">
              {user}
            </span>
          </div>
        </header>
        <main id="main" class={"mx-auto px-4 py-5 " + (wide ? "max-w-7xl" : "max-w-6xl")}>
          <h1 class="mb-4 text-title font-semibold">{title}</h1>
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

// The page around every private view: a header naming the app's private
// sections and who is signed in, then the content. It sets its own neutral
// look (ADMIN_THEME below); only the app's accent and fonts carry through.
// Pass `css` for the app's built stylesheet.
//
//   c.html(<AdminLayout title="Submissions" css="/site.css" nav={NAV} current="/admin/submissions" user={c.get("user")}>…</AdminLayout>)
import type { Context } from "hono";
import type { Child } from "hono/jsx";
import { Flash, type FlashMessages } from "./flash";
import type { TeamVars } from "./guard";
import { ViewerZoneScript } from "./viewer";

export type NavItem = { href: string; label: string };

/** A page's head: its title, the list it belongs to, a line under the title, its actions (at most one primary). */
export type Head = { title: string; back?: { href: string; label: string }; sub?: Child; actions?: Child };
/** An app's own page frame (the CRM's layout), given each page's head and the tab it is under (`current`). */
export type Frame = (p: Head & { user: string; current: string; children: Child }) => Child;

/**
 * A section's pages as tabs, the current one underlined. One line that
 * scrolls sideways on a narrow screen, as GitHub's and Stripe's do, never a
 * second row. The line under them is an inset shadow, so the scrolling
 * row cannot clip it and the current tab's underline sits on top.
 */
export function SectionTabs({ label, links, current }: { label: string; links: NavItem[]; current: string }) {
  return (
    <nav aria-label={label} class="mb-6 flex gap-1 overflow-x-auto text-copy font-medium shadow-[inset_0_-1px_0_var(--color-line)] [scrollbar-width:none]">
      {links.map((n) => (
        <a href={n.href} aria-current={current === n.href ? "page" : undefined}
          class={"shrink-0 whitespace-nowrap border-b-2 px-3 py-2 no-underline " + (current === n.href ? "border-accent text-ink" : "border-transparent text-ink-3 hover:border-line hover:text-ink")}>
          {n.label}
        </a>
      ))}
    </nav>
  );
}

/**
 * A page of a skill's section: in the app's own frame, or in AdminLayout with
 * the section's pages as its nav. A list page shows the section's tabs; a
 * record's page (one with `back`) shows the way back instead.
 */
function SectionPage(p: { Frame?: Frame; css: string; user: string; label: string; links: NavItem[]; current: string; head: Head; children: Child }) {
  const { head } = p;
  if (!p.Frame) {
    return (
      <AdminLayout title={head.title} back={head.back} sub={head.sub} actions={head.actions} css={p.css} nav={p.links} current={p.current} user={p.user}>
        {p.children}
      </AdminLayout>
    );
  }
  // One page is no set of tabs.
  const tabs = head.back || p.links.length < 2 ? null : <SectionTabs label={p.label} links={p.links} current={p.current} />;
  return <>{p.Frame({ ...head, user: p.user, current: p.current, children: <>{tabs}{p.children}</> })}</>;
}

/**
 * A section's page maker, made once per mount: `page(c, current, head, body,
 * status)` answers with a page of it, `current` the tab it is under, `head` a
 * title or a whole head, and the flash its routes redirect with above `body`.
 */
export function sectionPages(o: { Frame?: Frame; css: string; label: string; links: NavItem[]; messages: FlashMessages }) {
  return (c: Context<{ Variables: TeamVars }>, current: string, head: string | Head, body: Child, status = 200) =>
    c.html(
      <SectionPage Frame={o.Frame} css={o.css} user={c.get("user")} label={o.label} links={o.links} current={current} head={typeof head === "string" ? { title: head } : head}>
        <Flash code={c.req.query("saved")} n={c.req.query("n")} messages={o.messages} />
        {body}
      </SectionPage>,
      status as 200,
    );
}

/**
 * The private pages' own look, as Tailwind's application layouts have it: a
 * white page and cards, gray text and lines (Tailwind's gray scale), 14px
 * text, plain labels, smaller corners. The site's brand palette and type
 * are for visitors (18px copy, letter-spaced labels); a tool reads cleaner
 * neutral, and the same in every app. Only the accent and the fonts stay the
 * brand's. Set on <body>: every utility reads these variables (bg-canvas,
 * text-ink, text-copy, rounded-card), so a private page takes them and the
 * site's pages do not. A token renamed in the app's styles/theme.css must be
 * renamed here too.
 */
export const ADMIN_THEME = [
  "--color-canvas: #ffffff", // the page
  "--color-surface: #ffffff", // cards, inputs
  "--color-panel: #f3f4f6", // gray-100: the current nav item, a flash, a chip
  "--color-ink: #111827", // gray-900
  "--color-ink-2: #4b5563", // gray-600
  "--color-ink-3: #6b7280", // gray-500
  "--color-line: rgb(17 24 39 / 0.1)", // gray-900/10: card edges, dividers
  "--color-line-strong: #868c96", // input outlines: 3.4:1 on white, the 3:1 a field's edge needs
  "--shadow-card: 0 1px 2px rgb(0 0 0 / 0.05)", // shadow-xs
  "--text-copy: 0.875rem", // text-sm/6: body, table cells, cards
  "--text-copy--line-height: 1.5rem",
  "--text-label: 0.8125rem", // column heads, field names: no letter spacing, medium
  "--text-label--line-height: 1.25rem",
  "--text-label--letter-spacing: 0",
  "--text-label--font-weight: 500",
  "--text-title: 1.5rem", // text-2xl/8: a page's title
  "--text-title--line-height: 2rem",
  "--radius-card: 0.75rem", // rounded-xl
].join("; ");

/** One centered column for the nav and the page, as Tailwind's stacked layout has it, so their edges line up. */
const CONTAINER = "mx-auto max-w-6xl px-4 sm:px-6 lg:px-8";

const SIDEBAR_ICONS = {
  leads: "M3 12h5l2 3h4l2-3h5M5 5h14l2 7v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6l2-7Z",
  reports: "M4 20V10m6 10V4m6 16v-7m5 7H3",
  appointments: "M8 3v3m8-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  site: "M14 4h6v6m0-6-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  settings: "M4 7h10m4 0h2M4 17h2m4 0h10M14 5v4h4V5h-4ZM6 15v4h4v-4H6Z",
  menu: "M4 7h16M4 12h16M4 17h16",
} as const;
const SidebarIcon = ({ name }: { name: keyof typeof SIDEBAR_ICONS }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-5 shrink-0"><path d={SIDEBAR_ICONS[name]} /></svg>
);
/** A sidebar entry; `under` is the paths it stays lit on, when it heads more than its own. */
export type SidebarItem = { href: string; label: string; icon: keyof typeof SIDEBAR_ICONS; under?: string[] };

const SidebarLink = ({ item, current }: { item: SidebarItem; current: string }) => {
  const on = (item.under ?? [item.href]).some((u) => u !== "/" && current.startsWith(u));
  return (
    <a href={item.href} aria-current={on ? "page" : undefined} class={"flex min-h-11 items-center gap-2.5 rounded-control px-2.5 font-medium no-underline " + (on ? "bg-panel text-ink" : "text-ink-2 hover:bg-panel/60 hover:text-ink")}>
      <SidebarIcon name={item.icon} />{item.label}
    </a>
  );
};

/**
 * A frame for an app's private pages: a sidebar (the app's sections, then `foot` at its base) and the page. Below lg
 * the sidebar is a drawer, opened by the bar's menu link through :target, so it needs no script.
 */
export const sidebarFrame = (o: { brand: string; logo?: string; css: string; items: SidebarItem[]; foot?: SidebarItem[] }) =>
  ({ title, back, sub, actions, user, current, children }: Parameters<Frame>[0]) => (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{title}</title>
        <link rel="stylesheet" href={o.css} />
        <script src={HTMX_SRC} defer></script>
        <ViewerZoneScript />
      </head>
      <body class="min-h-screen bg-canvas font-body text-copy text-ink" style={ADMIN_THEME}>
        <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-control focus:bg-accent focus:px-3 focus:py-1 focus:text-accent-ink">Skip to content</a>
        <header class="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface px-4 lg:hidden">
          <a href="#nav" aria-label="Open the menu" class="-ml-1.5 inline-flex size-11 items-center justify-center rounded-control text-ink-2"><SidebarIcon name="menu" /></a>
          <span class="min-w-0 truncate font-semibold">{o.brand}</span>
        </header>
        <aside id="nav" aria-label="Menu" class="peer fixed inset-y-0 left-0 z-40 hidden w-72 flex-col overflow-y-auto border-r border-line bg-surface p-3 target:flex lg:flex lg:w-60">
          <p class="mb-4 flex min-h-12 items-center gap-2.5 px-2.5">{o.logo ? <img src={o.logo} alt="" class="size-9 object-contain" /> : null}<span class="min-w-0 truncate font-semibold text-ink">{o.brand}</span></p>
          <nav aria-label="Main" class="grid gap-1">{o.items.map((item) => <SidebarLink item={item} current={current} />)}</nav>
          <div class="mt-auto grid gap-1 pt-6">
            {(o.foot ?? []).map((item) => <SidebarLink item={item} current={current} />)}
            <p class="truncate px-2.5 py-2 text-sm text-ink-3">{user}</p>
          </div>
        </aside>
        <a href="#" aria-label="Close the menu" tabindex={-1} class="fixed inset-0 z-30 hidden bg-ink/30 peer-target:block lg:hidden!"></a>
        <div class="lg:pl-60">
          <main id="main" class="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
            {back ? <p class="mb-1 text-label"><a href={back.href} class="inline-block py-2 text-ink-2 no-underline hover:text-ink hover:underline sm:py-0">← {back.label}</a></p> : null}
            <div class="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
              <div class="min-w-0">
                <h1 class="text-title font-semibold">{title}</h1>
                {sub ? <div class="mt-1 text-ink-2">{sub}</div> : null}
              </div>
              {actions ? <div class="flex flex-wrap items-center gap-2">{actions}</div> : null}
            </div>
            {children}
          </main>
        </div>
      </body>
    </html>
  );

export const HTMX_SRC = "https://cdnjs.cloudflare.com/ajax/libs/htmx/2.0.6/htmx.min.js";

export function AdminLayout(props: {
  title: string;
  /** The list this page belongs to: a link above the title. */
  back?: { href: string; label: string };
  /** A line under the title, and the page's actions beside it (at most one primary). */
  sub?: Child;
  actions?: Child;
  css: string;
  nav: NavItem[];
  current: string;
  user: string;
  head?: Child;
  children?: Child;
}) {
  const { title, back, sub, actions, css, nav, current, user, head, children } = props;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{title}</title>
        <link rel="stylesheet" href={css} />
        <script src={HTMX_SRC} defer></script>
        <ViewerZoneScript />
        {head}
      </head>
      <body class="min-h-screen bg-canvas font-body text-copy text-ink" style={ADMIN_THEME}>
        <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-control focus:bg-accent focus:px-3 focus:py-1 focus:text-accent-ink">
          Skip to content
        </a>
        <header class="border-b border-line bg-surface">
          <div class={`${CONTAINER} flex min-h-14 flex-wrap items-center gap-x-6 gap-y-2 py-2`}>
            <nav aria-label="Private" class="flex max-w-full items-center gap-1 overflow-x-auto whitespace-nowrap">
              {nav.map((n) => (
                <a
                  href={n.href}
                  aria-current={current === n.href ? "page" : undefined}
                  class={"rounded-control px-3 py-2 text-sm font-medium no-underline " + (current === n.href ? "bg-panel text-ink" : "text-ink-2 hover:bg-panel/60 hover:text-ink")}
                >
                  {n.label}
                </a>
              ))}
            </nav>
            <span class="ml-auto hidden truncate text-sm text-ink-3 sm:block">{user}</span>
          </div>
        </header>
        <main id="main" class={`${CONTAINER} py-8`}>
          {back ? <p class="mb-1 text-label"><a href={back.href} class="inline-block py-2 text-ink-2 no-underline hover:text-ink hover:underline sm:py-0">← {back.label}</a></p> : null}
          <div class="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
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

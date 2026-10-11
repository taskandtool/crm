// The page around every private view: a header naming the app's private
// sections and who is signed in, then the content. Styled only with the theme
// tokens every Starter App's theme.css defines (canvas, surface, panel, ink,
// ink-2, ink-3, line, line-strong, accent, accent-ink; radius-card,
// radius-control; text-title, text-label, text-copy), so it takes on the
// app's brand with no change. Pass `css` for the app's built stylesheet.
//
//   c.html(<AdminLayout title="Submissions" css="/site.css" nav={NAV} current="/admin/submissions" user={c.get("user")}>…</AdminLayout>)
import type { Child } from "hono/jsx";

export type NavItem = { href: string; label: string };

/** A page's head: its title, the list it belongs to, a line under the title, its actions (at most one primary). */
export type Head = { title: string; back?: { href: string; label: string }; sub?: Child; actions?: Child };
/** An app's own page frame (the CRM's layout), given each page's head. */
export type Frame = (p: Head & { user: string; children: Child }) => Child;

/** A section's pages as tabs, the current one underlined. */
export function SectionTabs({ label, links, current }: { label: string; links: NavItem[]; current: string }) {
  return (
    <nav aria-label={label} class="mb-4 flex flex-wrap gap-1 border-b border-line text-label">
      {links.map((n) => (
        <a href={n.href} aria-current={current === n.href ? "page" : undefined}
          class={"-mb-px border-b-2 px-3 py-2 no-underline " + (current === n.href ? "border-accent font-semibold text-ink" : "border-transparent text-ink-2 hover:border-line-strong hover:text-ink")}>
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
export function SectionPage(p: { Frame?: Frame; css: string; user: string; label: string; links: NavItem[]; current: string; head: Head; children: Child }) {
  const { head } = p;
  if (!p.Frame) {
    // AdminLayout has a title and nav only: the rest of the head opens the body.
    const top = head.back || head.sub || head.actions ? (
      <div class="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div class="min-w-0">
          {head.back ? <p class="text-label"><a href={head.back.href}>{head.back.label}</a></p> : null}
          {head.sub ? <div class="text-ink-2">{head.sub}</div> : null}
        </div>
        {head.actions ? <div class="flex flex-wrap items-center gap-2">{head.actions}</div> : null}
      </div>
    ) : null;
    return <AdminLayout title={head.title} css={p.css} nav={p.links} current={p.current} user={p.user}>{top}{p.children}</AdminLayout>;
  }
  const tabs = head.back ? null : <SectionTabs label={p.label} links={p.links} current={p.current} />;
  return <>{p.Frame({ ...head, user: p.user, children: <>{tabs}{p.children}</> })}</>;
}

export const HTMX_SRC = "https://cdnjs.cloudflare.com/ajax/libs/htmx/2.0.6/htmx.min.js";

export function AdminLayout(props: {
  title: string;
  css: string;
  nav: NavItem[];
  current: string;
  user: string;
  head?: Child;
  children?: Child;
}) {
  const { title, css, nav, current, user, head, children } = props;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{title}</title>
        <link rel="stylesheet" href={css} />
        <script src={HTMX_SRC} defer></script>
        {head}
      </head>
      <body class="min-h-screen bg-canvas font-body text-copy text-ink">
        <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-control focus:bg-accent focus:px-3 focus:py-1 focus:text-accent-ink">
          Skip to content
        </a>
        <header class="border-b border-line bg-surface">
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
            <nav aria-label="Private" class="flex flex-wrap items-center gap-1">
              {nav.map((n) => (
                <a
                  href={n.href}
                  aria-current={current === n.href ? "page" : undefined}
                  class={"rounded-control px-2 py-1 no-underline " + (current === n.href ? "bg-panel font-semibold" : "text-ink-2 hover:bg-panel")}
                >
                  {n.label}
                </a>
              ))}
            </nav>
            <span class="ml-auto truncate text-label text-ink-3">{user}</span>
          </div>
        </header>
        <main id="main" class="mx-auto max-w-6xl px-4 py-6">
          <h1 class="mb-4 text-title font-semibold">{title}</h1>
          {children}
        </main>
      </body>
    </html>
  );
}

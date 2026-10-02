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

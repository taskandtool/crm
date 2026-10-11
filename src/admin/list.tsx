// A private list: the search and filter form, the table, the rows, and the
// "Load more" row that keyset paging drives. One TableSpec describes the
// columns once; the full page, the htmx partials (more rows, one updated
// row) and the plain-link fallbacks all render from it.
//
//   const spec: TableSpec<Row> = { id: "subs", columns, href: (r) => `/admin/submissions/${r.id}` };
//   <SearchBar action="/admin/submissions" target="#results" q={f.q} filters={[...]} />
//   <div id="results"><DataTable spec={spec} caption="Submissions" rows={page} next={next} more={(cur) => listUrl(base, { ...f, after: cur })} empty="Nothing yet." /></div>
//
// The route answers the same URL three ways: `after` with an htmx request is
// <TableRows> alone (it replaces the Load more row), any other htmx request
// is the #results block, and a plain request is the whole page.
import type { Child } from "hono/jsx";
import { listUrl } from "./query";
import { buttonClass, controlClass } from "./status";

export type Column<T> = { label: string; cell: (row: T) => Child; class?: string };

export type TableSpec<T extends { id: string | number | bigint }> = {
  /** Unique on the page; rows get `${id}-row-${row.id}`. Letters, digits, - and _ only. */
  id: string;
  columns: Column<T>[];
  /** Detail URL; the first column links to it. */
  href?: (row: T) => string;
  /** A checkbox per row belonging to the BulkForm with this id. */
  select?: { form: string; label: (row: T) => string };
};

export type Option = { value: string; label: string };
export type Filter = { name: string; label: string; options: Option[]; value?: string | null; any?: string };

// Borders sit on the cells, not the rows: with collapsed borders a hovered
// row's background paints over part of the header's line in Safari.
const cell = "px-4 py-3 align-top";

export function DataTable<T extends { id: string | number | bigint }>(props: {
  spec: TableSpec<T>;
  caption: string;
  rows: T[];
  next: string | null;
  more: (cursor: string) => string;
  empty: Child;
}) {
  const { spec, caption, rows, next, more, empty } = props;
  const width = spec.columns.length + (spec.select ? 1 : 0);
  const form = spec.select?.form.replace(/[^\w-]/g, "");
  return (
    <div class="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
      <table id={spec.id} class="w-full border-separate border-spacing-0 text-copy">
        <caption class="sr-only">{caption}</caption>
        <thead>
          <tr class="text-left text-label text-ink-2">
            {form ? (
              <th scope="col" class={cell + " w-10 border-b border-line"}>
                <input
                  type="checkbox"
                  aria-label="Select all shown"
                  onclick={`for (const b of document.querySelectorAll('input[form=${form}][name=id]')) b.checked = this.checked`}
                />
              </th>
            ) : null}
            {spec.columns.map((c) => (
              <th scope="col" class={cell + " border-b border-line font-semibold " + (c.class ?? "")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody id={`${spec.id}-rows`}>
          {rows.length ? (
            <TableRows spec={spec} rows={rows} next={next} more={more} />
          ) : (
            <tr>
              <td colspan={width} class="px-4 py-10">
                {typeof empty === "string" ? <EmptyState title={empty} /> : empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * An empty list, as Tailwind's empty states and HubSpot's say it: what goes
 * here (the title), how it fills (a line), and the button that makes the
 * first one. Inside a DataTable's `empty`, or in EmptyCard on its own.
 */
export function EmptyState({ title, children, action }: { title: string; children?: Child; action?: Child }) {
  return (
    <div class="text-center">
      <p class="font-semibold text-ink">{title}</p>
      {children ? <p class="mx-auto mt-1 max-w-md text-ink-2">{children}</p> : null}
      {action ? <div class="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/** EmptyState on a card of its own, where there is no table around it. */
export function EmptyCard(props: { title: string; children?: Child; action?: Child }) {
  return (
    <div class="rounded-card border border-line bg-surface px-4 py-10 shadow-card">
      <EmptyState {...props} />
    </div>
  );
}

/** A search or filter that found nothing: say so, and offer the way back. */
export function NoMatches({ clear }: { clear: string }) {
  return <EmptyState title="Nothing matches these filters." action={<a href={clear} class={buttonClass}>Clear filters</a>} />;
}

/** The rows, then a Load more row when there is a next page. Also the htmx answer to "Load more". */
export function TableRows<T extends { id: string | number | bigint }>(props: {
  spec: TableSpec<T>;
  rows: T[];
  next: string | null;
  more: (cursor: string) => string;
}) {
  const { spec, rows, next, more } = props;
  return (
    <>
      {rows.map((r) => (
        <TableRow spec={spec} row={r} />
      ))}
      {next ? <LoadMoreRow id={`${spec.id}-more`} href={more(next)} width={spec.columns.length + (spec.select ? 1 : 0)} /> : null}
    </>
  );
}

/**
 * As Stripe's and Linear's lists: a click anywhere on a row opens it, and
 * Cmd, Ctrl or the middle button opens it in a new tab. A click on something
 * of its own (a link, a checkbox, a button, a menu) or one that selects text
 * is left alone. The first cell's link stays the way there for the keyboard
 * and screen readers. A handler, not a link stretched over the row: Safari
 * measures that against the whole table, so every row opened the last one.
 */
export function rowClick(href: string) {
  const go =
    "if(event.target.closest('a,button,input,select,textarea,label,summary,details')||getSelection().toString())return;" +
    "if(event.metaKey||event.ctrlKey||event.button===1)window.open(this.dataset.href);else location.assign(this.dataset.href)";
  return { "data-href": href, onclick: go, onauxclick: `if(event.button===1){${go}}` };
}

/** The first cell's link: the row's name, no underline (the row shows it can be clicked). */
export const rowLink = "font-semibold text-ink no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

/** One row. Also the htmx answer to a change made in it (target "closest tr"). */
export function TableRow<T extends { id: string | number | bigint }>({ spec, row }: { spec: TableSpec<T>; row: T }) {
  const href = spec.href?.(row);
  return (
    <tr id={`${spec.id}-row-${row.id}`} class={"group hover:bg-canvas" + (href ? " cursor-pointer" : "")} {...(href ? rowClick(href) : {})}>
      {spec.select ? (
        <td class={cell + " border-b border-line group-last:border-b-0"}>
          <input type="checkbox" name="id" value={String(row.id)} form={spec.select.form} aria-label={`Select ${spec.select.label(row)}`} />
        </td>
      ) : null}
      {spec.columns.map((c, i) => (
        <td class={cell + " border-b border-line group-last:border-b-0 " + (c.class ?? "")}>
          {i === 0 && href ? (
            <a href={href} class={rowLink}>
              {c.cell(row)}
            </a>
          ) : (
            c.cell(row)
          )}
        </td>
      ))}
    </tr>
  );
}

/**
 * Swaps itself for the next rows under htmx. Without JavaScript the same
 * href is a full page of the next rows; the route offers a way back to the
 * newest there.
 */
export function LoadMoreRow({ id, href, width }: { id: string; href: string; width: number }) {
  return (
    <tr id={id}>
      <td colspan={width} class="px-3 py-3 text-center">
        <a href={href} hx-get={href} hx-target="closest tr" hx-swap="outerHTML" hx-push-url="false" class={buttonClass}>
          Load more
        </a>
      </td>
    </tr>
  );
}

/**
 * The search and filter form. A plain GET form; with htmx it searches as
 * you type (300 ms after the last key), refilters on a select change, swaps
 * `target`, and pushes the URL so back and refresh keep the filter.
 */
export function SearchBar(props: {
  action: string;
  target: string;
  q?: string | null;
  label?: string;
  placeholder?: string;
  filters?: Filter[];
  /** Values the search carries unchanged, as a view chosen with tabs above it: { view: "done" }. */
  keep?: Record<string, string | null | undefined>;
}) {
  const { action, target, q, label = "Search", placeholder, filters = [], keep = {} } = props;
  const active = !!q || filters.some((f) => f.value);
  // Each select's first option ("Any status") says what it filters, so its label is for screen readers.
  return (
    <form
      method="get"
      action={action}
      role="search"
      hx-get={action}
      hx-target={target}
      hx-swap="outerHTML"
      hx-push-url="true"
      class="mb-4 flex flex-wrap items-center gap-2"
    >
      {Object.entries(keep).map(([name, value]) => (value ? <input type="hidden" name={name} value={value} /> : null))}
      <label class="relative min-w-48 flex-1">
        <span class="sr-only">{label}</span>
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3">
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" />
        </svg>
        <input
          type="search"
          name="q"
          value={q ?? ""}
          placeholder={placeholder}
          autocomplete="off"
          hx-get={action}
          hx-trigger="input changed delay:300ms, search"
          hx-include="closest form"
          class={controlClass + " w-full pl-8"}
        />
      </label>
      {filters.map((f) => (
        <label class="min-w-32 flex-1 sm:flex-none">
          <span class="sr-only">{f.label}</span>
          <select name={f.name} hx-get={action} hx-trigger="change" hx-include="closest form" class={controlClass + " w-full"}>
            <option value="">{f.any ?? "All"}</option>
            {f.options.map((o) => (
              <option value={o.value} selected={o.value === f.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      {/* htmx applies every change; the button is for a browser without it. */}
      <noscript>
        <button class={buttonClass}>Apply</button>
      </noscript>
      {active ? (
        <a href={listUrl(action, keep)} class="px-1 text-label text-ink-2">
          Clear
        </a>
      ) : null}
    </form>
  );
}

/**
 * A time in the business's zone, "Oct 9, 2:30 PM", with the year only when it
 * is not this one; `day` leaves the time out. The server's zone is UTC on the
 * machine and at the edge, so formatting without `timeZone` shows the wrong hour.
 */
export function When({ at, timeZone, locale = "en-US", day = false }: { at: Date | string | null | undefined; timeZone: string; locale?: string; day?: boolean }) {
  if (!at) return null;
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const year = (x: Date) => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(x);
  const text = new Intl.DateTimeFormat(locale, {
    timeZone,
    month: "short",
    day: "numeric",
    year: year(d) === year(new Date()) ? undefined : "numeric",
    ...(day ? {} : { hour: "numeric", minute: "2-digit" }),
  }).format(d);
  return (
    <time datetime={d.toISOString()} class="whitespace-nowrap">
      {text}
    </time>
  );
}

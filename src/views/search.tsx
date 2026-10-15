// Search: the matches grouped by kind, as Pipedrive's and HubSpot's search
// show them. Under the sidebar's box as you type (a few of each), and as a
// page of their own on Enter (more of each, and the way to each full list).
import { listUrl } from "../admin/query";
import { inputClass } from "../admin/status";
import { dealsCfg, invoicesCfg, vocab } from "../config";
import type { Hit, Hits } from "../crm/search";
import { Layout } from "./layout";

type Group = { label: string; hits: Hit[]; href: (id: string) => string; all: string | null };

function groups(h: Hits, q: string): Group[] {
  const word = invoicesCfg?.word ?? "Quote";
  const all: Group[] = [
    { label: vocab.many, hits: h.contacts, href: (id) => `/customers/${id}`, all: listUrl("/customers", { q }) },
    // No "All leads": the list shows one status at a time, and these are every status.
    { label: "Leads", hits: h.leads, href: (id) => `/leads/${id}`, all: null },
    { label: dealsCfg.many, hits: h.deals, href: (id) => `/deals/${id}`, all: null },
    // Quotes and invoices only where this CRM shows them; the tables may be another app's.
    { label: `${word}s`, hits: invoicesCfg ? h.quotes : [], href: (id) => `/invoices/quotes/${id}`, all: listUrl("/invoices/quotes", { q }) },
    { label: "Invoices", hits: invoicesCfg ? h.invoices : [], href: (id) => `/invoices/${id}`, all: listUrl("/invoices", { q }) },
  ];
  return all.filter((g) => g.hits.length);
}

const count = (h: Hits) => h.contacts.length + h.leads.length + h.deals.length + h.quotes.length + h.invoices.length;

/** Under the sidebar's search as you type: a few of each kind, then the whole page. Nothing for an empty box. */
export function SearchPeek({ q, hits }: { q: string; hits: Hits }) {
  if (q.trim().length < 2) return <div id="search-peek"></div>;
  return (
    <div id="search-peek" class="absolute inset-x-0 z-20 mt-1 max-h-[70vh] overflow-y-auto rounded-control bg-surface p-1 shadow-lift ring-1 ring-line">
      {count(hits) ? groups(hits, q).map((g) => (
        <div class="py-1">
          <p class="px-2.5 py-1 text-label font-medium text-ink-3">{g.label}</p>
          {g.hits.map((x) => (
            <a href={g.href(x.id)} class="block rounded-control px-2.5 py-1.5 no-underline hover:bg-panel">
              <span class="block truncate font-medium text-ink">{x.title}</span>
              {x.sub ? <span class="block truncate text-label text-ink-3">{x.sub}</span> : null}
            </a>
          ))}
        </div>
      )) : <p class="px-2.5 py-2 text-ink-3">Nothing matches.</p>}
      <a href={listUrl("/search", { q })} class="block border-t border-line px-2.5 pt-2 pb-1.5 font-medium text-ink-2 no-underline hover:text-ink">All results for "{q}"</a>
    </div>
  );
}

/** Search's own page: each kind as a card of its matches, with the way to its full list. */
export function SearchPage({ user, q, hits }: { user: string; q: string; hits: Hits }) {
  const shown = groups(hits, q);
  return (
    <Layout title={q ? `Search: ${q}` : "Search"} heading="Search" user={user} section="search"
      sub={q ? (count(hits) ? `Matches for "${q}"` : `Nothing matches "${q}".`) : "Type a name, an email, a phone number, a deal or a quote number."}>
      <form method="get" action="/search" role="search" class="mb-6 max-w-xl">
        <label>
          <span class="sr-only">Search</span>
          <input type="search" name="q" value={q} autofocus class={inputClass} />
        </label>
      </form>
      <div class="grid items-start gap-4 lg:grid-cols-2">
        {shown.map((g) => (
          <section class="rounded-card bg-surface shadow-card ring-1 ring-line">
            <div class="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
              <h2 class="text-heading font-semibold">{g.label}</h2>
              {g.all ? <a href={g.all} class="text-label font-medium text-ink-2 no-underline hover:text-ink">All {g.label.toLowerCase()}</a> : null}
            </div>
            <ul class="flex flex-col divide-y divide-line px-5">
              {g.hits.map((x) => (
                <li class="py-2.5">
                  <a href={g.href(x.id)} class="block truncate font-medium text-ink no-underline hover:underline">{x.title}</a>
                  {x.sub ? <p class="truncate text-label text-ink-3">{x.sub}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Layout>
  );
}

// Proposals' data: which components each quote has, what happens when they
// sign, the page stored on the quote, its link, and who opened it. A
// component's design and words are code (components/); nothing here edits
// them. Edge-safe: the same code saves on the machine and in production.
//
//   await ensureProposal(db, quote);                       // a new quote: components ticked as last time
//   await saveProposal(db, quote.id, input, by);           // the checklist and "After they sign"
//   await storePage(db, quote.id, opts);                   // re-made on every save
//   const link = await mintLink(db, quote.id, by, base);   // shown once
import { q, type Db } from "../data/db";
import { formatMoney } from "../payments/money";
import { taxRates, type TaxRate } from "../payments/tax";
import { dayText } from "../invoices/document";
import { EDITABLE, isEditable, quoteById, type Quote } from "../invoices/quotes";
import type { Errors, Saved, SavedLine } from "../invoices/lines";
import { COMPONENTS, PICKABLE, type PageData } from "./components";
import { renderPage } from "./page";

/** What the app tells proposals about the business. */
export type ProposalOpts = {
  business: string;
  word: string;
  timeZone: string;
  locale?: string;
};

export type FirstInvoice = "none" | "draft" | "send";
export type Proposal = {
  quote_id: string;
  title: string | null;
  first_invoice: FirstInvoice;
  deposit_percent: number | null;
  page_html: string | null;
  page_sha256: string | null;
  rendered_at: Date | null;
  link_made_at: Date | null;
  emailed_at: Date | null;
  decline_reason: string | null;
  decline_note: string | null;
};

const MAX_PAGE_BYTES = 9 * 1024 * 1024;
/** The statuses a quote is still edited in (invoices skill's EDITABLE). */
const EDITING: string[] = EDITABLE;

// ---- a quote's proposal ------------------------------------------------------

const toProposal = (r: Record<string, any>): Proposal => ({
  quote_id: String(r.quote_id), title: r.title ?? null, first_invoice: r.first_invoice, deposit_percent: r.deposit_percent ?? null,
  page_html: r.page_html ?? null, page_sha256: r.page_sha256 ?? null, rendered_at: r.rendered_at ? new Date(r.rendered_at) : null,
  link_made_at: r.link_made_at ? new Date(r.link_made_at) : null, emailed_at: r.emailed_at ? new Date(r.emailed_at) : null,
  decline_reason: r.decline_reason ?? null, decline_note: r.decline_note ?? null,
});

export async function proposalOf(db: Db, quoteId: string): Promise<Proposal | null> {
  if (!/^\d{1,18}$/.test(quoteId)) return null;
  const [r] = await db.sql`select * from quote_proposals where quote_id = ${quoteId}::bigint`;
  return r ? toProposal(r) : null;
}

/** The components ticked on a new quote: as on this customer's last proposal, else each component's default. */
async function startingKeys(db: Db, qt: Pick<Quote, "id" | "email">): Promise<string[]> {
  const last = await db.sql`
    select qc.key from quote_components qc
    where qc.quote_id = (select max(p.quote_id) from quote_proposals p join quotes oq on oq.id = p.quote_id
                         where oq.email = ${qt.email}::citext and p.quote_id <> ${qt.id}::bigint)`;
  const known = new Set(PICKABLE.map((c) => c.key));
  const before = last.map((r) => r.key as string).filter((k) => known.has(k));
  return before.length ? before : PICKABLE.filter((c) => c.on).map((c) => c.key);
}

/** A quote's proposal, made once, its components ticked as on this customer's last one. Safe to repeat. */
export async function ensureProposal(db: Db, qt: Pick<Quote, "id" | "email">): Promise<void> {
  if ((await db.sql`select 1 from quote_proposals where quote_id = ${qt.id}::bigint`).length) return;
  const keys = await startingKeys(db, qt);
  await db.transaction([
    q`insert into quote_proposals (quote_id) values (${qt.id}::bigint) on conflict do nothing`,
    q`insert into quote_components (quote_id, key) select ${qt.id}::bigint, k from unnest(${keys}::text[]) as k on conflict do nothing`,
  ]);
}

/** The components ticked on a quote, by key. */
export async function chosenKeys(db: Db, quoteId: string): Promise<string[]> {
  const rows = await db.sql`select key from quote_components where quote_id = ${quoteId}::bigint`;
  return rows.map((r) => r.key as string);
}

/** Before Send: the ticked components whose words are still the starter's samples, in a sentence; null when none. */
export async function sampleWarning(db: Db, quoteId: string): Promise<string | null> {
  const keys = new Set(await chosenKeys(db, quoteId));
  const labels = COMPONENTS.filter((c) => (c.always || keys.has(c.key)) && c.sample).map((c) => c.label);
  if (!labels.length) return null;
  const one = labels.length === 1;
  return `${labels.join(", ")} still ${one ? "shows" : "show"} sample words: ask the AI to write ${one ? "it" : "them"} from your website first, or untick ${one ? "it" : "them"} on the quote.`;
}

export type ProposalInput = { title?: unknown; first_invoice?: unknown; deposit_percent?: unknown; components: string[] };

/**
 * The quote's checklist and "After they sign": its title, which components
 * it has, the first invoice and a deposit. Only while the quote is still
 * editable; a signature in between wins.
 */
export async function saveProposal(db: Db, quoteId: string, input: ProposalInput, by: string): Promise<Saved<null>> {
  const qt = await quoteById(db, quoteId);
  if (!qt) return { ok: false, errors: { status: "No such quote." } };
  if (!isEditable(qt)) return { ok: false, errors: { status: `It was ${qt.status}, so it no longer changes.` } };
  await ensureProposal(db, qt);
  const errors: Errors = {};
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length > 160) errors.title = "Up to 160 characters.";
  const first = input.first_invoice === "draft" || input.first_invoice === "send" ? input.first_invoice : "none";
  const rawPct = typeof input.deposit_percent === "string" ? input.deposit_percent.trim().replace(/%$/, "") : input.deposit_percent == null ? "" : String(input.deposit_percent);
  const pct = rawPct === "" || rawPct === "100" ? null : Number(rawPct);
  if (pct !== null && !(Number.isInteger(pct) && pct >= 1 && pct <= 99)) errors.deposit_percent = "A whole percent from 1 to 100, or blank for the full total.";
  const odd = input.components.filter((k) => !PICKABLE.some((c) => c.key === k));
  if (odd.length) errors.components = `No component ${odd.join(", ")}: they are ${PICKABLE.map((c) => c.key).join(", ")}.`;
  if (Object.keys(errors).length) return { ok: false, errors };
  const keys = [...new Set(input.components)];
  const out = await db.transaction([
    q`select status from quotes where id = ${quoteId}::bigint for update`,
    // Each write checks the status itself, behind the lock.
    q`delete from quote_components where quote_id = ${quoteId}::bigint and exists (select 1 from quotes where id = ${quoteId}::bigint and status = any(${EDITING}::text[]))`,
    q`insert into quote_components (quote_id, key) select ${quoteId}::bigint, k from unnest(${keys}::text[]) as k
      where exists (select 1 from quotes where id = ${quoteId}::bigint and status = any(${EDITING}::text[])) on conflict do nothing`,
    q`update quote_proposals set title = ${title || null}, first_invoice = ${first}, deposit_percent = ${pct}::int, updated_by = ${by}, updated_at = now()
      where quote_id = ${quoteId}::bigint and exists (select 1 from quotes where id = ${quoteId}::bigint and status = any(${EDITING}::text[]))`,
  ]);
  if (!EDITING.includes(out[0][0]?.status)) return { ok: false, errors: { status: `It was ${out[0][0]?.status ?? "removed"}, so it no longer changes.` } };
  return { ok: true, value: null };
}

// ---- the page ------------------------------------------------------------------

/** What a deposit of `pct` comes to: each tax rate's share of the lines and its tax, as invoiceFromQuote makes it. */
function depositCents(lines: SavedLine[], rates: TaxRate[], pct: number): number {
  const groups = new Map<string, number>();
  for (const l of lines) groups.set(l.tax_rate_id ?? "", (groups.get(l.tax_rate_id ?? "") ?? 0) + Number(l.amount_cents));
  let total = 0;
  for (const [rate, amount] of groups) {
    const share = Math.round((amount * pct) / 100);
    const r = rates.find((x) => x.id === rate);
    const tax = !r ? 0 : r.inclusive ? share - Math.round((share * 10000) / (10000 + r.percent_bp)) : Math.round((share * r.percent_bp) / 10000);
    total += share + (r && !r.inclusive ? tax : 0);
  }
  return total;
}

/** What signing does, in a sentence for the customer (printed under the total) and one for the team. */
export function afterSign(p: Pick<Proposal, "first_invoice" | "deposit_percent">, qt: Quote & { lines: SavedLine[] }, rates: TaxRate[], locale?: string): { customer: string; team: string } {
  const m = (c: number | string) => formatMoney(c, qt.currency, locale);
  const pct = p.deposit_percent;
  const amount = pct ? depositCents(qt.lines, rates, pct) : Number(qt.total_cents);
  const what = pct ? `a ${pct}% deposit of ${m(amount)}` : `the full ${m(amount)}`;
  if (p.first_invoice === "send") {
    return {
      customer: `When you sign, ${pct ? `${what} is due` : `the invoice for ${m(amount)} is due`}, and you are taken straight to pay it online.`,
      team: `When they sign: an invoice for ${what} is sent and they are taken to pay it.`,
    };
  }
  if (p.first_invoice === "draft") {
    return { customer: "When you sign, we send your invoice.", team: `When they sign: a draft invoice for ${what} is made for you to review; nothing is sent.` };
  }
  return { customer: "When you sign, we send your invoice.", team: "When they sign: nothing else happens; make the invoice from this page." };
}

/** The page for this quote as it stands, rendered: what Preview shows and the link serves. */
export async function pageFor(db: Db, quoteId: string, opts: ProposalOpts): Promise<{ html: string; sha: string; bytes: number } | null> {
  const qt = await quoteById(db, quoteId);
  if (!qt) return null;
  await ensureProposal(db, qt);
  const [p, keys, rates] = await Promise.all([proposalOf(db, quoteId), chosenKeys(db, quoteId), taxRates(db)]);
  const data: PageData = {
    word: opts.word, business: opts.business, timeZone: opts.timeZone, locale: opts.locale, quote: qt, rates,
    title: p?.title?.trim() || `${opts.word} ${qt.number}`,
    afterSign: afterSign(p!, qt, rates, opts.locale).customer,
  };
  const html = renderPage(data, keys);
  return { html, sha: await sha256(html), bytes: new TextEncoder().encode(html).length };
}

/**
 * Re-make the quote's stored page. Only while it is editable: a decided
 * quote's page never changes. Refused, and nothing stored, over 5 MB.
 */
export async function storePage(db: Db, quoteId: string, opts: ProposalOpts): Promise<{ ok: true; sha: string } | { ok: false; why: string }> {
  const page = await pageFor(db, quoteId, opts);
  if (!page) return { ok: false, why: "No such quote." };
  if (page.bytes > MAX_PAGE_BYTES) return { ok: false, why: `The page would be ${(page.bytes / 1048576).toFixed(1)} MB, over 9 MB: its components carry too many photographs.` };
  const rows = await db.sql`
    update quote_proposals p set page_html = ${page.html}, page_sha256 = ${page.sha}, rendered_at = now()
    from quotes q where p.quote_id = ${quoteId}::bigint and q.id = p.quote_id and q.status = any(${EDITING}::text[])
    returning p.quote_id`;
  return rows.length ? { ok: true, sha: page.sha } : { ok: false, why: "It was decided, so its page no longer changes." };
}

// ---- the link and its opens ----------------------------------------------------

/**
 * A new link for the quote: 32 random bytes, base64url, of which only the
 * SHA-256 is ever stored. It works, and any earlier link stops working,
 * once `keep` runs: after the email carrying it went, so a send that fails
 * leaves the customer's link working.
 */
export async function newLink(db: Db, quoteId: string, by: string, base: string): Promise<{ url: string; keep: () => Promise<void> }> {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256(token);
  return {
    url: `${base.replace(/\/+$/, "")}/q/${token}`,
    keep: async () => {
      await db.sql`
        insert into quote_proposals (quote_id, token_sha256, link_made_at, link_made_by) values (${quoteId}::bigint, ${hash}, now(), ${by})
        on conflict (quote_id) do update set token_sha256 = excluded.token_sha256, link_made_at = now(), link_made_by = excluded.link_made_by, emailed_at = null`;
    },
  };
}

/** A new link, in force at once (Copy link, New link). */
export async function mintLink(db: Db, quoteId: string, by: string, base: string): Promise<string> {
  const link = await newLink(db, quoteId, by, base);
  await link.keep();
  return link.url;
}

/** The email carrying the link went out: opens in the next minute are mail scanners. */
export async function markEmailed(db: Db, quoteId: string): Promise<void> {
  await db.sql`update quote_proposals set emailed_at = now() where quote_id = ${quoteId}::bigint`;
}

/** The quote a token opens, or null for one that is not a link's. */
export async function quoteIdByToken(db: Db, token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [r] = await db.sql`select quote_id::text as id from quote_proposals where token_sha256 = ${await sha256(token)}`;
  return r?.id ?? null;
}

export type Who = "customer" | "team" | "scanner";
const SCANNER_SECONDS = 60;

/** Record an open; a customer's first makes the quote Viewed (invoices skill). */
export async function recordView(db: Db, quoteId: string, team: boolean, ip: string | null, browser: string | null): Promise<Who> {
  const [r] = await db.sql<{ who: Who }>`
    with p as (select emailed_at from quote_proposals where quote_id = ${quoteId}::bigint),
    v as (
      insert into quote_views (quote_id, who, ip, browser)
      select ${quoteId}::bigint,
             case when ${team} then 'team'
                  when (select emailed_at from p) > now() - make_interval(secs => ${SCANNER_SECONDS}::int) then 'scanner'
                  else 'customer' end,
             ${ip?.slice(0, 64) ?? null}, ${browser?.slice(0, 300) ?? null}
      returning who),
    seen as (update quotes set viewed_at = now() where id = ${quoteId}::bigint and viewed_at is null and status = 'sent'
             and (select who from v) = 'customer' returning id)
    select who from v`;
  return r.who;
}

export type Opens = { customer: number; last: Date | null; first: Date | null; team: number; scanner: number; recent: { at: Date; who: Who }[] };

export async function opensOf(db: Db, quoteId: string): Promise<Opens> {
  const rows = await db.sql`select at, who from quote_views where quote_id = ${quoteId}::bigint order by at desc limit 500`;
  const mine = rows.filter((r) => r.who === "customer");
  return {
    customer: mine.length, last: mine[0] ? new Date(mine[0].at) : null, first: mine.length ? new Date(mine.at(-1)!.at) : null,
    team: rows.filter((r) => r.who === "team").length, scanner: rows.filter((r) => r.who === "scanner").length,
    recent: rows.slice(0, 8).map((r) => ({ at: new Date(r.at), who: r.who })),
  };
}

// ---- bytes ---------------------------------------------------------------------

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function toBase64Url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Proposals' data: the library of sections, each quote's ticked sections
// and its own words, pictures, the page stored on the quote, its link, and
// who opened it. Edge-safe: the same code saves on the machine and in
// production.
//
//   await ensureProposal(db, quote, opts);                 // a new quote: sections ticked as last time
//   await saveProposal(db, quote.id, input, by, opts);     // the editor
//   await storePage(db, quote.id, opts);                   // re-made on every save
//   const link = await mintLink(db, quote.id, by, base);   // shown once
import { q, type Db } from "../data/db";
import { formatMoney } from "../payments/money";
import { taxRates, type TaxRate } from "../payments/tax";
import { dayText } from "../invoices/document";
import { EDITABLE, isEditable, quoteById, type Quote } from "../invoices/quotes";
import type { Errors, Saved, SavedLine } from "../invoices/lines";
import { renderPage, type PageData } from "./page";
import { SECTIONS, sectionDef, type Content, type Entry, type SectionDef } from "./sections";
import { fill, plain, unknownPlaceholders, type Facts } from "./text";

/** What the app tells proposals about the business. */
export type ProposalOpts = {
  business: string;
  word: string;
  timeZone: string;
  locale?: string;
  /** The standing terms (crm.config.json invoices.terms): the Terms section's words until the library has its own. */
  terms?: string | null;
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

export const MAX_IMAGE_BYTES = 400 * 1024;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
/** The statuses a quote is still edited in (invoices skill's EDITABLE). */
const EDITING: string[] = EDITABLE;

// ---- the library -------------------------------------------------------------

type LibraryRow = Content & { ticked: boolean; saved: boolean };

/** Each section's standing content: the library's row, else its defaults. */
export async function library(db: Db, opts: Pick<ProposalOpts, "terms">): Promise<Map<string, LibraryRow>> {
  const rows = await db.sql`select key, title, texts, entries, ticked from proposal_sections`;
  const out = new Map<string, LibraryRow>();
  for (const def of SECTIONS) {
    const r = rows.find((x) => x.key === def.key);
    out.set(def.key, r
      ? { title: r.title, texts: r.texts ?? {}, entries: r.entries ?? [], ticked: def.always ? true : r.ticked, saved: true }
      : { title: def.title, texts: def.key === "terms" && opts.terms ? { terms: opts.terms } : {}, entries: [], ticked: def.ticked, saved: false });
  }
  return out;
}

/**
 * A section's content as typed: the title, each of its texts and its entries,
 * checked against its definition. Blank entries drop; a placeholder that is
 * not one is refused, so it never goes out as written. Picture ids must be
 * this project's.
 */
async function readContent(db: Db, def: SectionDef, input: { title?: unknown; texts?: unknown; entries?: unknown }): Promise<Saved<Content>> {
  const errors: Errors = {};
  const s = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "");
  const title = s(input.title);
  if (title.length > 160) errors.title = "Up to 160 characters.";
  const texts: Record<string, string> = {};
  const given = (input.texts && typeof input.texts === "object" ? input.texts : {}) as Record<string, unknown>;
  for (const t of def.texts) {
    const v = s(given[t.name]);
    if (v.length > 10000) errors[`texts.${t.name}`] = "Up to 10,000 characters.";
    const odd = unknownPlaceholders(v);
    if (odd.length) errors[`texts.${t.name}`] = `${odd.join(", ")} ${odd.length === 1 ? "is not a placeholder" : "are not placeholders"}: use {customer}, {business}, {total}, {valid_until} or {number}, or take the braces off.`;
    if (v) texts[t.name] = v;
  }
  const entries: Entry[] = [];
  const rows = Array.isArray(input.entries) ? (input.entries as Record<string, unknown>[]) : [];
  const images: string[] = [];
  rows.forEach((row, i) => {
    if (!def.entries) return;
    const e: Entry = {};
    for (const f of def.entries.fields) {
      const v = s(row?.[f.name]);
      if (!v) continue;
      if (f.kind === "image") {
        if (!/^\d{1,18}$/.test(v)) errors[`entries.${i}.${f.name}`] = "Choose a picture from the list.";
        else images.push(v);
      } else if (f.kind === "rating") {
        if (!/^[1-5]$/.test(v)) errors[`entries.${i}.${f.name}`] = "Stars from 1 to 5, or none.";
      } else {
        if (v.length > f.max) errors[`entries.${i}.${f.name}`] = `Up to ${f.max} characters.`;
        const odd = unknownPlaceholders(v);
        if (odd.length) errors[`entries.${i}.${f.name}`] = `${odd.join(", ")} is not a placeholder.`;
      }
      e[f.name] = v;
    }
    if (Object.keys(e).length) entries.push(e);
  });
  if (def.entries && entries.length > def.entries.max) errors.entries = `Up to ${def.entries.max} ${def.entries.many.toLowerCase()}.`;
  if (images.length) {
    const found = await db.sql`select id::text as id from proposal_images where id = any(${images}::bigint[])`;
    const known = new Set(found.map((r) => r.id));
    rows.forEach((row, i) => {
      for (const f of def.entries?.fields ?? []) if (f.kind === "image" && s(row?.[f.name]) && !known.has(s(row?.[f.name]))) errors[`entries.${i}.${f.name}`] = "That picture is gone; choose another.";
    });
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { title: title || def.title, texts, entries } };
}

/** Save a library section, and whether a new quote ticks it. */
export async function saveLibrarySection(db: Db, key: string, input: { title?: unknown; texts?: unknown; entries?: unknown; ticked?: unknown }, by: string): Promise<Saved<Content>> {
  const def = sectionDef(key);
  if (!def) return { ok: false, errors: { key: "No such section." } };
  const r = await readContent(db, def, input);
  if (!r.ok) return r;
  const ticked = def.always ? true : input.ticked === true || input.ticked === "1" || input.ticked === "on";
  await db.sql`
    insert into proposal_sections (key, title, texts, entries, ticked, updated_by)
    values (${key}, ${r.value.title}, ${JSON.stringify(r.value.texts)}::jsonb, ${JSON.stringify(r.value.entries)}::jsonb, ${ticked}, ${by})
    on conflict (key) do update set title = excluded.title, texts = excluded.texts, entries = excluded.entries, ticked = excluded.ticked,
      updated_by = excluded.updated_by, updated_at = now()`;
  return r;
}

// ---- pictures ----------------------------------------------------------------

export type ImageInfo = { id: string; name: string | null; type: string; size: number; created_at: Date };

/** Keep a picture: JPEG, PNG or WebP, at most 400 KB (the browser resizes it first). */
export async function addImage(db: Db, f: { name: string; type: string; bytes: Uint8Array }, by: string): Promise<Saved<ImageInfo>> {
  if (!IMAGE_TYPES.includes(f.type)) return { ok: false, errors: { image: "A JPEG, PNG or WebP picture." } };
  if (!f.bytes.length) return { ok: false, errors: { image: "Choose a picture." } };
  if (f.bytes.length > MAX_IMAGE_BYTES) return { ok: false, errors: { image: `It is ${Math.ceil(f.bytes.length / 1024)} KB; at most 400 KB. Make it smaller (at most 1600 pixels wide) and add it again.` } };
  const [r] = await db.sql`
    insert into proposal_images (name, type, bytes, created_by) values (${f.name.slice(0, 200) || null}, ${f.type}, ${toHex(f.bytes)}::bytea, ${by})
    returning id::text as id, name, type, octet_length(bytes) as size, created_at`;
  return { ok: true, value: { ...r, size: Number(r.size) } as ImageInfo };
}

export async function listImages(db: Db): Promise<ImageInfo[]> {
  const rows = await db.sql`select id::text as id, name, type, octet_length(bytes) as size, created_at from proposal_images order by id desc limit 200`;
  return rows.map((r) => ({ ...r, size: Number(r.size) }) as ImageInfo);
}

/** One picture's bytes, for the team's own pages. */
export async function imageBytes(db: Db, id: string): Promise<{ type: string; bytes: Uint8Array } | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [r] = await db.sql`select type, encode(bytes, 'base64') as b64 from proposal_images where id = ${id}::bigint`;
  return r ? { type: r.type, bytes: fromBase64(r.b64) } : null;
}

/** The pictures these ids name, as data: URIs. */
async function dataUris(db: Db, ids: string[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((i) => /^\d{1,18}$/.test(i)))];
  if (!want.length) return new Map();
  const rows = await db.sql`select id::text as id, type, encode(bytes, 'base64') as b64 from proposal_images where id = any(${want}::bigint[])`;
  return new Map(rows.map((r) => [r.id, `data:${r.type};base64,${String(r.b64).replace(/\s+/g, "")}`]));
}

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

/**
 * A quote's proposal, made once: its sections ticked as on this customer's
 * last proposal, else as the library says. Safe to repeat.
 */
export async function ensureProposal(db: Db, qt: Pick<Quote, "id" | "email">, opts: Pick<ProposalOpts, "terms">): Promise<void> {
  const lib = await library(db, opts);
  const defaults = SECTIONS.filter((d) => lib.get(d.key)!.ticked).map((d) => d.key);
  await db.transaction([
    q`insert into quote_proposals (quote_id) values (${qt.id}::bigint) on conflict do nothing`,
    // Last time's choice, when this customer had a proposal before; else the library's.
    q`with last as (
        select qs.key, qs.ticked from quote_sections qs
        where qs.quote_id = (select max(o.quote_id) from quote_sections o join quotes oq on oq.id = o.quote_id
                             where oq.email = ${qt.email}::citext and o.quote_id <> ${qt.id}::bigint))
      insert into quote_sections (quote_id, key, ticked)
      select ${qt.id}::bigint, k.key,
             coalesce((select last.ticked from last where last.key = k.key), k.key = any(${defaults}::text[]))
      from unnest(${SECTIONS.map((s) => s.key)}::text[]) as k(key)
      on conflict do nothing`,
  ]);
}

export type SectionInput = { ticked?: boolean; title?: unknown; texts?: unknown; entries?: unknown };
export type ProposalInput = {
  title?: unknown;
  first_invoice?: unknown;
  deposit_percent?: unknown;
  sections: Record<string, SectionInput>;
};

/**
 * The editor's save: the title, which sections are ticked, each one's words
 * for this quote, and what happens when they sign. Only while the quote is
 * still editable. A section's words equal to the library's are stored as
 * the library's (null) on a draft, so a library fix reaches it.
 */
export async function saveProposal(db: Db, quoteId: string, input: ProposalInput, by: string, opts: ProposalOpts): Promise<Saved<null>> {
  const qt = await quoteById(db, quoteId);
  if (!qt) return { ok: false, errors: { status: "No such quote." } };
  if (!isEditable(qt)) return { ok: false, errors: { status: `It was ${qt.status}, so it no longer changes.` } };
  await ensureProposal(db, qt, opts);
  const errors: Errors = {};
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length > 160) errors.title = "Up to 160 characters.";
  const first = input.first_invoice === "draft" || input.first_invoice === "send" ? input.first_invoice : "none";
  const rawPct = typeof input.deposit_percent === "string" ? input.deposit_percent.trim().replace(/%$/, "") : input.deposit_percent == null ? "" : String(input.deposit_percent);
  const pct = rawPct === "" || rawPct === "100" ? null : Number(rawPct);
  if (pct !== null && !(Number.isInteger(pct) && pct >= 1 && pct <= 99)) errors.deposit_percent = "A whole percent from 1 to 100, or blank for the full total.";
  const lib = await library(db, opts);
  const statements = [];
  for (const def of SECTIONS) {
    const inp = input.sections[def.key];
    if (!inp) continue;
    const r = await readContent(db, def, inp);
    if (!r.ok) {
      for (const [k, v] of Object.entries(r.errors)) errors[`${def.key}.${k}`] = v;
      continue;
    }
    const base = lib.get(def.key)!;
    // On a draft, words that are the library's stay the library's; once sent, the quote keeps its own.
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const own = qt.status !== "draft";
    const t = own || r.value.title !== base.title ? r.value.title : null;
    const x = own || !same(r.value.texts, base.texts) ? JSON.stringify(r.value.texts) : null;
    const e = own || !same(r.value.entries, base.entries) ? JSON.stringify(r.value.entries) : null;
    const ticked = def.always ? true : inp.ticked === true;
    // Each write checks the status itself, behind the lock: a signature in between wins.
    statements.push(q`
      insert into quote_sections (quote_id, key, ticked, title, texts, entries)
      select ${quoteId}::bigint, ${def.key}, ${ticked}, ${t}, ${x}::jsonb, ${e}::jsonb
      where exists (select 1 from quotes where id = ${quoteId}::bigint and status = any(${EDITING}::text[]))
      on conflict (quote_id, key) do update set ticked = excluded.ticked, title = excluded.title, texts = excluded.texts, entries = excluded.entries`);
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  statements.push(q`
    update quote_proposals set title = ${title || null}, first_invoice = ${first}, deposit_percent = ${pct}::int, updated_by = ${by}, updated_at = now()
    where quote_id = ${quoteId}::bigint and exists (select 1 from quotes where id = ${quoteId}::bigint and status = any(${EDITING}::text[]))`);
  const out = await db.transaction([q`select status from quotes where id = ${quoteId}::bigint for update`, ...statements]);
  if (!EDITING.includes(out[0][0]?.status)) return { ok: false, errors: { status: `It was ${out[0][0]?.status ?? "removed"}, so it no longer changes.` } };
  return { ok: true, value: null };
}

/** Each ticked section's content for this quote, in page order: its own words, else the library's. */
export async function resolvedSections(db: Db, quoteId: string, opts: Pick<ProposalOpts, "terms">): Promise<{ key: string; ticked: boolean; content: Content; own: boolean }[]> {
  const [lib, rows] = await Promise.all([
    library(db, opts),
    db.sql`select key, ticked, title, texts, entries from quote_sections where quote_id = ${quoteId}::bigint`,
  ]);
  return SECTIONS.map((def) => {
    const r = rows.find((x) => x.key === def.key);
    const base = lib.get(def.key)!;
    return {
      key: def.key,
      ticked: def.always ? true : r ? r.ticked : base.ticked,
      own: !!r && (r.title !== null || r.texts !== null || r.entries !== null),
      content: { title: r?.title ?? base.title, texts: r?.texts ?? base.texts, entries: r?.entries ?? base.entries },
    };
  });
}

/** Sending: the library's words are copied into the quote, so a later library edit never changes what the customer has. */
export async function freezeSections(db: Db, quoteId: string, opts: Pick<ProposalOpts, "terms">): Promise<void> {
  const lib = await library(db, opts);
  const keys = SECTIONS.map((s) => s.key);
  await db.sql`
    update quote_sections qs set
      title = coalesce(qs.title, l.title), texts = coalesce(qs.texts, l.texts), entries = coalesce(qs.entries, l.entries)
    from (select * from unnest(${keys}::text[], ${keys.map((k) => lib.get(k)!.title)}::text[],
            ${keys.map((k) => JSON.stringify(lib.get(k)!.texts))}::jsonb[], ${keys.map((k) => JSON.stringify(lib.get(k)!.entries))}::jsonb[])
          as l(key, title, texts, entries)) l
    where qs.quote_id = ${quoteId}::bigint and qs.key = l.key`;
}

// ---- the page ------------------------------------------------------------------

/** The facts placeholders fill. */
function factsOf(qt: Quote, opts: ProposalOpts): Facts {
  return {
    customer: qt.name ?? qt.email,
    business: opts.business,
    total: formatMoney(qt.total_cents, qt.currency, opts.locale),
    valid_until: qt.valid_until ? dayText(qt.valid_until, opts.locale) : "",
    number: qt.number,
  };
}

const fillContent = (c: Content, f: Facts): Content => ({
  title: plain(fill(c.title, f)),
  texts: Object.fromEntries(Object.entries(c.texts).map(([k, v]) => [k, fill(v, f)])),
  entries: c.entries.map((e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, fill(v, f)]))),
});

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
  await ensureProposal(db, qt, opts);
  const [p, sections, rates] = await Promise.all([proposalOf(db, quoteId), resolvedSections(db, quoteId, opts), taxRates(db)]);
  const facts = factsOf(qt, opts);
  const shown = sections.filter((s) => s.ticked).map((s) => ({ key: s.key, content: fillContent(s.content, facts) }));
  const ids = shown.flatMap((s) => s.content.entries.flatMap((e) => Object.entries(e).filter(([k]) => ["logo", "photo", "image"].includes(k)).map(([, v]) => v)));
  const data: PageData = {
    word: opts.word, business: opts.business, timeZone: opts.timeZone, locale: opts.locale, quote: qt, rates,
    title: p?.title?.trim() ? plain(fill(p.title, facts)) : `${opts.word} ${qt.number}`,
    sections: shown, images: await dataUris(db, ids), afterSign: afterSign(p!, qt, rates, opts.locale).customer,
  };
  const html = renderPage(data);
  return { html, sha: await sha256(html), bytes: new TextEncoder().encode(html).length };
}

/**
 * Re-make the quote's stored page. Only while it is editable: a decided
 * quote's page never changes. Refused, and nothing stored, over 5 MB.
 */
export async function storePage(db: Db, quoteId: string, opts: ProposalOpts): Promise<{ ok: true; sha: string } | { ok: false; why: string }> {
  const page = await pageFor(db, quoteId, opts);
  if (!page) return { ok: false, why: "No such quote." };
  if (page.bytes > MAX_PAGE_BYTES) {
    const big = await db.sql`select coalesce(name, 'picture ' || id) as name, octet_length(bytes) as size from proposal_images order by octet_length(bytes) desc limit 3`;
    return { ok: false, why: `The page would be ${(page.bytes / 1048576).toFixed(1)} MB, over 5 MB. Use smaller pictures; the largest are ${big.map((b) => `${b.name} (${Math.ceil(Number(b.size) / 1024)} KB)`).join(", ")}.` };
  }
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
const toHex = (b: Uint8Array) => "\\x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
function toBase64Url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64(b64: string): Uint8Array {
  const s = atob(String(b64).replace(/\s+/g, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

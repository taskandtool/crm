// The team's side of proposals, team only: the library (Settings > Proposal
// sections, with its pictures), a quote's proposal (which sections, its own
// words, what happens when they sign), New link, the signed copy, and the
// panel on a quote's page that says where it stands: its link, who opened
// it, the signature. Every form works without JavaScript; crm.js only
// shrinks a picture before it is uploaded.
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import { FieldList, Section } from "../admin/detail";
import { alertClass, withFlash, type FlashMessages } from "../admin/flash";
import { teamOnly, type TeamVars } from "../admin/guard";
import { sectionPages, type Frame, type NavItem } from "../admin/layout";
import { When } from "../admin/list";
import { idParam, str } from "../admin/query";
import { buttonClass, controlClass, FieldError, fieldClass, inputClass, primaryClass, Select, smallText } from "../admin/status";
import type { GetDb, Db } from "../data/db";
import { taxRates } from "../payments/tax";
import { isEditable, quoteById, type Quote } from "../invoices/quotes";
import type { Errors, SavedLine } from "../invoices/lines";
import { fillPage } from "./page";
import { SECTIONS, sectionDef, TICKABLE, type Content, type SectionDef } from "./sections";
import { signedState } from "./sign";
import {
  addImage, afterSign, imageBytes, library, listImages, mintLink, opensOf, pageFor, proposalOf, resolvedSections, saveLibrarySection, saveProposal,
  storePage, MAX_IMAGE_BYTES, type ImageInfo, type ProposalOpts, type SectionInput,
} from "./store";
import { PLACEHOLDERS } from "./text";

type Ctx = Context<{ Variables: TeamVars }>;

export type ProposalAdminOpts = {
  opts: ProposalOpts;
  Frame?: Frame;
  css: string;
  nav: NavItem[];
  /** Where the quotes are (the invoices skill's pages): `${quotes}/:id`. */
  quotes: string;
  /** Production's address for a new link, or why there is none. */
  base: (c: Ctx) => Promise<{ ok: true; base: string } | { ok: false; why: string }>;
};

const MESSAGES: FlashMessages = {
  "section-saved": "Saved. New proposals use it; a draft that has not changed it does too.",
  "image-added": "Picture added. Choose it in a section.",
  "proposal-saved": "Saved. Preview it to see the page.",
  gone: "That is no longer there.",
};

/** The form's flat names for one section's fields: `<key>.title`, `<key>.text.<name>`, `<key>.entry.<field>` (one per row). */
const names = (key: string) => ({ title: `${key}.title`, text: (n: string) => `${key}.text.${n}`, entry: (f: string) => `${key}.entry.${f}`, tick: `${key}.ticked` });

/** One section's content as posted. */
function postedContent(body: Record<string, unknown>, def: SectionDef): SectionInput {
  const n = names(def.key);
  const all = (k: string) => {
    const v = body[k];
    return Array.isArray(v) ? v.map(str) : v === undefined ? [] : [str(v)];
  };
  const texts = Object.fromEntries(def.texts.map((t) => [t.name, str(body[n.text(t.name)])]));
  const columns = (def.entries?.fields ?? []).map((f) => [f.name, all(n.entry(f.name))] as const);
  const rows = Math.min(Math.max(0, ...columns.map(([, v]) => v.length)), 60);
  const entries = Array.from({ length: rows }, (_, i) => Object.fromEntries(columns.map(([name, v]) => [name, v[i] ?? ""])));
  return { title: body[n.title], texts, entries, ticked: str(body[n.tick]) === "1" };
}

const pictureName = (i: ImageInfo) => i.name || `Picture ${i.id}`;

/** A section's words and entries, editable: in the library, or for one quote. */
function ContentFields({ def, c, errors, images, prefixErrors = "" }: { def: SectionDef; c: Content; errors: Errors; images: ImageInfo[]; prefixErrors?: string }) {
  const n = names(def.key);
  const err = (k: string) => errors[prefixErrors + k];
  const rows = def.entries ? [...c.entries, ...Array.from({ length: Math.max(1, Math.min(3, def.entries.max - c.entries.length)) }, () => ({}) as Record<string, string>)] : [];
  return (
    <div class="flex flex-col gap-4">
      {def.key !== "cover" && def.key !== "accept" ? (
        <label class={fieldClass}>Title<input name={n.title} value={c.title} maxlength={160} class={inputClass} /><FieldError id={`${def.key}-title`} text={err("title")} /></label>
      ) : null}
      {def.texts.map((t) => (
        <label class={fieldClass}>
          {t.label}
          {t.hint ? <span class={smallText + " text-ink-3"}>{t.hint}</span> : null}
          <textarea name={n.text(t.name)} rows={t.name === "terms" ? 8 : 4} maxlength={10000} class={inputClass}>{c.texts[t.name] ?? ""}</textarea>
          <FieldError id={`${def.key}-${t.name}`} text={err(`texts.${t.name}`)} />
        </label>
      ))}
      {def.entries ? (
        <fieldset class="flex flex-col gap-3">
          <legend class="mb-2 text-sm/6 font-medium text-ink">{def.entries.many}</legend>
          <FieldError id={`${def.key}-entries`} text={err("entries")} />
          {rows.map((row, i) => (
            <div class={"grid gap-2 sm:grid-cols-2 " + (i ? "border-t border-line pt-3" : "")}>
              {def.entries!.fields.map((f) => {
                const v = row[f.name] ?? "";
                const e = err(`entries.${i}.${f.name}`);
                if (f.kind === "image") {
                  return (
                    <label class={fieldClass}>{f.label}
                      <Select name={n.entry(f.name)}>
                        <option value="">None</option>
                        {images.map((im) => <option value={im.id} selected={im.id === v}>{pictureName(im)}</option>)}
                      </Select>
                      <FieldError id={`${def.key}-${i}-${f.name}`} text={e} />
                    </label>
                  );
                }
                if (f.kind === "rating") {
                  return (
                    <label class={fieldClass}>{f.label}
                      <Select name={n.entry(f.name)}>
                        <option value="">None</option>
                        {["5", "4", "3", "2", "1"].map((s) => <option value={s} selected={s === v}>{s}</option>)}
                      </Select>
                      <FieldError id={`${def.key}-${i}-${f.name}`} text={e} />
                    </label>
                  );
                }
                return (
                  <label class={fieldClass + (f.kind === "long" ? " sm:col-span-2" : "")}>{f.label}
                    {f.kind === "long"
                      ? <textarea name={n.entry(f.name)} rows={3} maxlength={f.max} class={inputClass}>{v}</textarea>
                      : <input name={n.entry(f.name)} value={v} maxlength={f.max} class={inputClass} />}
                    <FieldError id={`${def.key}-${i}-${f.name}`} text={e} />
                  </label>
                );
              })}
            </div>
          ))}
          <p class={smallText + " text-ink-3"}>Blank rows are left out. Save to get more rows.</p>
        </fieldset>
      ) : null}
    </div>
  );
}

const PlaceholderHint = () => (
  <p class={smallText + " text-ink-3"}>
    Placeholders fill in each quote's own facts: {Object.entries(PLACEHOLDERS).map(([k, v], i) => <>{i ? ", " : ""}<code>{`{${k}}`}</code> {v}</>)}.
    Write **bold**, a list with dashes, and [a link](https://example.com).
  </p>
);

export function proposalAdmin(getDb: GetDb, o: ProposalAdminOpts) {
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());
  const framed = sectionPages({ Frame: o.Frame, css: o.css, label: "Quotes and invoices", links: o.nav, messages: MESSAGES });
  const back = (c: Ctx, path: string, code: string) => c.redirect(withFlash(path, code), 303);
  const lib = "/proposals";
  const W = o.opts.word, w = W.toLowerCase();

  // ---- the library ----------------------------------------------------------

  app.get(lib, async (c) => {
    const db = getDb(c);
    const [rows, images] = await Promise.all([library(db, o.opts), listImages(db)]);
    return framed(c, lib, { title: "Proposal sections" }, (
      <div class="flex flex-col gap-4">
        <p class="max-w-prose text-ink-2">
          Every {w} is built from these, in this order. Each one's words here are the standing ones: a new {w} starts with them, and you change them for one {w} on its page. Ticked ones are on a new {w} unless this customer's last one said otherwise.
        </p>
        <Section title="Sections">
          <ul class="flex flex-col divide-y divide-line">
            {SECTIONS.map((def) => {
              const r = rows.get(def.key)!;
              return (
                <li class="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div class="min-w-0">
                    <p class="font-semibold">{def.label}{def.always ? <span class="ml-2 text-label text-ink-3">On every {w}</span> : r.ticked ? <span class="ml-2 text-label text-ink-3">On by default</span> : null}</p>
                    <p class={smallText + " text-ink-2"}>{def.shows}</p>
                  </div>
                  {def.key !== "accept" ? <a href={`${lib}/sections/${def.key}`} class={buttonClass}>Edit</a> : null}
                </li>
              );
            })}
          </ul>
        </Section>
        <Section title="Pictures">
          <p class={smallText + " mb-3 text-ink-2"}>A logo, team photos, case studies. Each is made at most 1600 pixels wide before it is added, and kept with the CRM, so a customer's page carries it.</p>
          {images.length ? (
            <ul class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {images.map((im) => (
                <li class="flex flex-col gap-1">
                  <img src={`${lib}/images/${im.id}`} alt={pictureName(im)} class="aspect-square w-full rounded-card border border-line bg-panel object-cover" />
                  <span class="truncate text-label text-ink-2">{pictureName(im)} · {Math.ceil(im.size / 1024)} KB</span>
                </li>
              ))}
            </ul>
          ) : null}
          {c.req.query("problem") ? <p role="alert" class={"mb-3 " + alertClass}>{c.req.query("problem")}</p> : null}
          <form method="post" action={`${lib}/images`} enctype="multipart/form-data" class="flex flex-wrap items-end gap-3">
            <label class={fieldClass}>A picture<input type="file" name="image" accept="image/jpeg,image/png,image/webp" required data-resize="1600" class={smallText} /></label>
            <label class={fieldClass}>Name<input name="name" maxlength={200} placeholder="Our logo" class={controlClass} /></label>
            <button class={buttonClass}>Add picture</button>
          </form>
        </Section>
      </div>
    ));
  });

  const sectionPage = async (c: Ctx, def: SectionDef, content: Content & { ticked: boolean }, errors: Errors, status = 200) => {
    const images = await listImages(getDb(c));
    return framed(c, lib, { title: `${def.label}: the standing words`, back: { href: lib, label: "Proposal sections" } }, (
      <form method="post" action={`${lib}/sections/${def.key}`} class="flex max-w-3xl flex-col gap-4">
        {Object.keys(errors).length ? <p role="alert" class={alertClass}>Fix what is marked below. Nothing was saved.</p> : null}
        <Section title={def.label}>
          <p class={smallText + " mb-4 text-ink-2"}>{def.shows}.</p>
          <ContentFields def={def} c={content} errors={errors} images={images} />
          {def.always ? null : (
            <label class="mt-4 flex items-center gap-2"><input type="checkbox" name={names(def.key).tick} value="1" checked={content.ticked} class="size-4" /> On a new {w} by default</label>
          )}
        </Section>
        <PlaceholderHint />
        <div class="flex items-center gap-3"><button class={primaryClass}>Save</button><a href={lib} class="text-label text-ink-2">Cancel</a></div>
      </form>
    ), status);
  };

  app.get(`${lib}/sections/:key`, async (c) => {
    const def = sectionDef(c.req.param("key"));
    if (!def || def.key === "accept") return c.notFound();
    const r = (await library(getDb(c), o.opts)).get(def.key)!;
    return sectionPage(c, def, r, {});
  });

  app.post(`${lib}/sections/:key`, async (c) => {
    const def = sectionDef(c.req.param("key"));
    if (!def || def.key === "accept") return c.notFound();
    const posted = postedContent(await c.req.parseBody({ all: true }), def);
    const r = await saveLibrarySection(getDb(c), def.key, { ...posted, ticked: posted.ticked ? "1" : "" }, c.get("user"));
    if (!r.ok) return sectionPage(c, def, { title: str(posted.title), texts: posted.texts as Record<string, string>, entries: posted.entries as Record<string, string>[], ticked: !!posted.ticked }, r.errors, 422);
    return back(c, lib, "section-saved");
  });

  app.post(`${lib}/images`, async (c) => {
    const body = await c.req.parseBody();
    const file = body.image;
    if (!(file instanceof File)) return c.redirect(`${lib}?problem=${encodeURIComponent("Choose a picture.")}`, 303);
    if (file.size > MAX_IMAGE_BYTES * 4) return c.redirect(`${lib}?problem=${encodeURIComponent("That picture is far over 400 KB. Make it smaller and add it again.")}`, 303);
    const r = await addImage(getDb(c), { name: str(body.name) || file.name.replace(/\.[a-z0-9]+$/i, ""), type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }, c.get("user"));
    if (!r.ok) return c.redirect(`${lib}?problem=${encodeURIComponent(r.errors.image)}`, 303);
    return back(c, lib, "image-added");
  });

  app.get(`${lib}/images/:id`, async (c) => {
    const img = await imageBytes(getDb(c), c.req.param("id"));
    if (!img) return c.notFound();
    return new Response(img.bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": img.type, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
  });

  // ---- a quote's proposal ---------------------------------------------------------

  const editor = async (c: Ctx, qt: Quote, values: { title: string; first: string; pct: string; sections: { def: SectionDef; ticked: boolean; content: Content }[] }, errors: Errors, status = 200) => {
    const images = await listImages(getDb(c));
    const self = `${o.quotes}/${qt.id}`;
    const always = values.sections.filter((s) => s.def.always && s.def.key !== "accept");
    return framed(c, o.quotes, { title: `The ${w} ${qt.number}`, back: { href: self, label: `${W} ${qt.number}` } }, (
      <form method="post" action={`${self}/proposal`} class="flex max-w-3xl flex-col gap-4">
        {Object.keys(errors).length ? <p role="alert" class={alertClass}>{errors.status ?? "Fix what is marked below. Nothing was saved."}</p> : null}
        <Section title="Title">
          <label class={fieldClass}>What it is, at the top of the page<input name="title" value={values.title} maxlength={160} placeholder={`${W} ${qt.number}`} class={inputClass} /><FieldError id="title" text={errors.title} /></label>
        </Section>
        {always.map((s) => (
          <Section title={s.def.label}>
            <p class={smallText + " mb-3 text-ink-2"}>{s.def.shows}. Always on.</p>
            <ContentFields def={s.def} c={s.content} errors={errors} images={images} prefixErrors={`${s.def.key}.`} />
          </Section>
        ))}
        <Section title="Sections">
          <p class={smallText + " mb-3 text-ink-2"}>Tick what this {w} has; each one's words start as the standing ones in Settings, and change here for this {w} only.</p>
          <div class="flex flex-col divide-y divide-line">
            {values.sections.filter((s) => !s.def.always).map((s) => (
              <div class="py-3">
                <label class="flex items-start gap-3">
                  <input type="checkbox" name={names(s.def.key).tick} value="1" checked={s.ticked} class="mt-1 size-4" />
                  <span><span class="font-semibold">{s.def.label}</span><span class={"block " + smallText + " text-ink-2"}>{s.def.shows}</span></span>
                </label>
                <details class="mt-2 pl-7" open={s.ticked && Object.keys(errors).some((k) => k.startsWith(`${s.def.key}.`))}>
                  <summary class="cursor-pointer text-label text-ink-2">Its words for this {w}</summary>
                  <div class="mt-3"><ContentFields def={s.def} c={s.content} errors={errors} images={images} prefixErrors={`${s.def.key}.`} /></div>
                </details>
              </div>
            ))}
          </div>
          <div class="mt-3"><PlaceholderHint /></div>
        </Section>
        <Section title="After they sign">
          <fieldset class="flex flex-col gap-2">
            <legend class="sr-only">The first invoice</legend>
            {([["none", "Nothing: I send the invoice myself"], ["draft", "Make a draft invoice for me to review"], ["send", "Send the invoice through Stripe, and take them to pay it"]] as const).map(([v, label]) => (
              <label class="flex items-center gap-2"><input type="radio" name="first_invoice" value={v} checked={values.first === v} class="size-4" /> {label}</label>
            ))}
          </fieldset>
          <label class={fieldClass + " mt-4 max-w-xs"}>A deposit, in percent (blank for the full total)
            <input name="deposit_percent" value={values.pct} inputmode="numeric" placeholder="50" class={inputClass} />
            <FieldError id="deposit" text={errors.deposit_percent} />
          </label>
          <p class={smallText + " mt-3 text-ink-3"}>The customer reads what happens in the pricing section, above the place they sign. A deposit carries the same share of the tax.</p>
        </Section>
        <div class="flex items-center gap-3">
          <button class={primaryClass}>Save</button>
          <a href={`${self}/document`} target="_blank" class={buttonClass}>Preview</a>
          <a href={self} class="text-label text-ink-2">Cancel</a>
        </div>
      </form>
    ), status);
  };

  const loadQuote = async (c: Ctx) => {
    const id = idParam(c.req.param("id"));
    return id ? quoteById(getDb(c), id) : null;
  };

  app.get(`${o.quotes}/:id/proposal`, async (c) => {
    const qt = await loadQuote(c);
    if (!qt) return c.notFound();
    if (!isEditable(qt)) return c.redirect(`${o.quotes}/${qt.id}`, 302);
    const db = getDb(c);
    await pageFor(db, qt.id, o.opts);
    const [p, sections] = await Promise.all([proposalOf(db, qt.id), resolvedSections(db, qt.id, o.opts)]);
    return editor(c, qt, {
      title: p?.title ?? "", first: p?.first_invoice ?? "none", pct: p?.deposit_percent ? String(p.deposit_percent) : "",
      sections: sections.map((s) => ({ def: sectionDef(s.key)!, ticked: s.ticked, content: s.content })),
    }, {});
  });

  app.post(`${o.quotes}/:id/proposal`, async (c) => {
    const qt = await loadQuote(c);
    if (!qt) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    const posted = Object.fromEntries(SECTIONS.filter((d) => d.key !== "accept").map((d) => [d.key, postedContent(body, d)]));
    const db = getDb(c);
    const r = await saveProposal(db, qt.id, { title: body.title, first_invoice: str(body.first_invoice), deposit_percent: str(body.deposit_percent), sections: posted }, c.get("user"), o.opts);
    if (!r.ok) {
      return editor(c, qt, {
        title: str(body.title), first: str(body.first_invoice) || "none", pct: str(body.deposit_percent),
        sections: SECTIONS.filter((d) => d.key !== "accept").map((def) => ({
          def, ticked: def.always ? true : !!posted[def.key].ticked,
          content: { title: str(posted[def.key].title), texts: posted[def.key].texts as Record<string, string>, entries: posted[def.key].entries as Record<string, string>[] },
        })),
      }, r.errors, 422);
    }
    const stored = await storePage(db, qt.id, o.opts);
    if (!stored.ok) return c.redirect(`${o.quotes}/${qt.id}?problem=${encodeURIComponent(stored.why)}`, 303);
    return back(c, `${o.quotes}/${qt.id}`, "proposal-saved");
  });

  // A new link: the old one stops working. Shown once, as Copy link shows it.
  app.post(`${o.quotes}/:id/proposal/link`, async (c) => {
    const qt = await loadQuote(c);
    if (!qt) return c.notFound();
    const self = `${o.quotes}/${qt.id}`;
    if (qt.status !== "sent") return c.redirect(self, 303);
    const base = await o.base(c);
    if (!base.ok) return c.redirect(`${self}?problem=${encodeURIComponent(`No new link: ${base.why}`)}`, 303);
    const link = await mintLink(getDb(c), qt.id, c.get("user"), base.base);
    return framed(c, o.quotes, { title: `A new link to ${w} ${qt.number}`, back: { href: self, label: `${W} ${qt.number}` } }, (
      <Section title="Copy it now">
        <p class="mb-3 max-w-prose">The link sent before no longer works. Send {qt.name ?? qt.email} this one; it is shown once.</p>
        <input readonly value={link} aria-label="The link" class={controlClass + " w-full font-mono"} data-select-all />
        <p class="mt-3"><a href={self} class={buttonClass}>Done</a></p>
      </Section>
    ));
  });

  // The signed copy, as the customer has it.
  app.get(`${o.quotes}/:id/proposal/signed`, async (c) => {
    const qt = await loadQuote(c);
    if (!qt) return c.notFound();
    const db = getDb(c);
    const [sig] = await db.sql`select 1 from quote_signatures where quote_id = ${qt.id}::bigint`;
    const p = await proposalOf(db, qt.id);
    if (!sig || !p?.page_html) return c.notFound();
    return c.html(fillPage(p.page_html, await signedState(db, qt.id, o.opts), W));
  });

  return app;
}

/** The quote as its customer reads it, for Preview and the PDF: the signed copy once signed. */
export async function proposalDocument(db: Db, qt: Quote, opts: ProposalOpts): Promise<string> {
  const [sig] = await db.sql`select 1 from quote_signatures where quote_id = ${qt.id}::bigint`;
  const p = await proposalOf(db, qt.id);
  if (sig && p?.page_html) return fillPage(p.page_html, await signedState(db, qt.id, opts), opts.word);
  // A decided quote keeps the page it had; one still open is drawn from its current words.
  const html = isEditable(qt) || !p?.page_html ? (await pageFor(db, qt.id, opts))?.html ?? "" : p.page_html;
  return fillPage(html, { kind: "preview" }, opts.word);
}

/** The proposal's part of a quote's page: what it has, what signing does, its link, who opened it, the answer. */
export async function proposalPanel(db: Db, qt: Quote & { lines: SavedLine[] }, o: { opts: ProposalOpts; quotes: string; timeZone: string }): Promise<Child> {
  const [p, sections, opens, rates] = await Promise.all([proposalOf(db, qt.id), resolvedSections(db, qt.id, o.opts), opensOf(db, qt.id), taxRates(db)]);
  const [sig] = await db.sql`select name, email::text as email, signed_at, ip from quote_signatures where quote_id = ${qt.id}::bigint`;
  const self = `${o.quotes}/${qt.id}`;
  const ticked = sections.filter((s) => s.ticked && !sectionDef(s.key)!.always).map((s) => sectionDef(s.key)!.label);
  const after = p ? afterSign(p, qt, rates).team : null;
  const w = o.opts.word.toLowerCase();
  const opened = opens.customer
    ? <>Opened {opens.customer === 1 ? "once" : `${opens.customer} times`}, last <When at={opens.last!} timeZone={o.timeZone} /></>
    : qt.status === "sent" && p?.link_made_at ? "Not opened yet" : null;
  const aside = [opens.scanner ? `${opens.scanner} by a mail scanner` : "", opens.team ? `${opens.team} by your team` : ""].filter(Boolean).join(", ");
  return (
    <Section title={`The ${w}`}>
      <FieldList fields={[
        { label: "Title", value: p?.title || null },
        { label: "Sections", value: ticked.length ? ticked.join(", ") : "Only the cover, pricing and accept" },
        { label: "When they sign", value: after ? after.replace(/^When they sign: /, "").replace(/^./, (x) => x.toUpperCase()) : null },
        { label: "Link", value: p?.link_made_at ? <>Made <When at={p.link_made_at} timeZone={o.timeZone} />{p.emailed_at ? <>, emailed <When at={p.emailed_at} timeZone={o.timeZone} /></> : ", given by hand"}</> : null },
        { label: "Opened", value: opened ? <>{opened}{aside ? <span class="block text-label text-ink-3">Not counted: {aside}</span> : null}</> : null },
        { label: "Signed", value: sig ? <>{sig.name}, <When at={new Date(sig.signed_at)} timeZone={o.timeZone} /><span class="block text-label text-ink-3">{sig.email}{sig.ip ? `, from ${sig.ip}` : ""}</span></> : null },
        { label: "Declined", value: p?.decline_reason ? <>{p.decline_reason}{p.decline_note ? <span class="block whitespace-pre-wrap text-ink-2">{p.decline_note}</span> : null}</> : null },
      ]} />
      <div class="mt-4 flex flex-wrap gap-2">
        {isEditable(qt) ? <a href={`${self}/proposal`} class={buttonClass}>Edit the {w}</a> : null}
        {sig ? <a href={`${self}/proposal/signed`} target="_blank" class={buttonClass}>The signed copy</a> : null}
        {qt.status === "sent" && p?.link_made_at ? (
          <form method="post" action={`${self}/proposal/link`}><button class={buttonClass}>New link</button></form>
        ) : null}
      </div>
    </Section>
  );
}

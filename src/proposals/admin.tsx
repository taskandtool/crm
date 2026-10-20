// The team's side of proposals, team only: the panel on a quote's page, with
// the checklist of its components by name (their design and words are code
// the AI writes from the brand record), its title, and where it stands: its
// link, who opened it, the signature. Then New link and the signed copy.
// What their yes sends is the invoices on the quote (the quote's page lists
// them). Every form works without JavaScript.
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import { FieldList, Section } from "../admin/detail";
import { withFlash, type FlashMessages } from "../admin/flash";
import { teamOnly, type TeamVars } from "../admin/guard";
import { sectionPages, type Frame, type NavItem } from "../admin/layout";
import { AskAi, When } from "../admin/list";
import { idParam, str } from "../admin/query";
import { buttonClass, controlClass, fieldClass, inputClass, primaryClass, smallText } from "../admin/status";
import type { GetDb, Db } from "../data/db";
import { isEditable, quoteById, type Quote } from "../invoices/quotes";
import type { SavedLine } from "../invoices/lines";
import { COMPONENTS, PICKABLE } from "./components";
import { fillPage } from "./page";
import { signedState } from "./sign";
import type { Base } from "./link";
import { chosenKeys, ensureProposal, mintLink, opensOf, proposalOf, saveProposal, storePage, type ProposalOpts } from "./store";

type Ctx = Context<{ Variables: TeamVars }>;

export type ProposalAdminOpts = {
  opts: ProposalOpts;
  Frame?: Frame;
  css: string;
  nav: NavItem[];
  /** Where the quotes are (the invoices skill's pages): `${quotes}/:id`. */
  quotes: string;
  /** Production's address for a new link, or why there is none. */
  base: (c: Ctx) => Promise<Base>;
};

const MESSAGES: FlashMessages = {};

/** Beside a component's name while its words are the starter's; gone once the AI writes it. */
const SampleTag = () => <span class="text-ink-3"> (sample)</span>;

export function proposalAdmin(getDb: GetDb, o: ProposalAdminOpts) {
  const app = new Hono<{ Variables: TeamVars }>();
  app.use("*", teamOnly());
  const framed = sectionPages({ Frame: o.Frame, css: o.css, label: "Quotes and invoices", links: o.nav, messages: MESSAGES });
  const W = o.opts.word, w = W.toLowerCase();

  const loadQuote = async (c: Ctx) => {
    const id = idParam(c.req.param("id"));
    return id ? quoteById(getDb(c), id) : null;
  };

  app.post(`${o.quotes}/:id/proposal`, async (c) => {
    const qt = await loadQuote(c);
    if (!qt) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    const picked = Array.isArray(body.components) ? body.components.map(str) : body.components === undefined ? [] : [str(body.components)];
    const db = getDb(c);
    const r = await saveProposal(db, qt.id, { title: body.title, components: picked }, c.get("user"));
    if (!r.ok) return c.redirect(`${o.quotes}/${qt.id}?problem=${encodeURIComponent(`Nothing was saved: ${Object.values(r.errors).join(" ")}`)}`, 303);
    const stored = await storePage(db, qt.id, o.opts);
    if (!stored.ok) return c.redirect(`${o.quotes}/${qt.id}?problem=${encodeURIComponent(stored.why)}`, 303);
    return c.redirect(withFlash(`${o.quotes}/${qt.id}`, "saved"), 303);
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

/** The proposal's part of a quote's page: its components, its link, who opened it, the answer. */
export async function proposalPanel(db: Db, qt: Quote & { lines: SavedLine[] }, o: { opts: ProposalOpts; quotes: string; timeZone: string }): Promise<Child> {
  await ensureProposal(db, qt);
  const [p, keys, opens] = await Promise.all([proposalOf(db, qt.id), chosenKeys(db, qt.id), opensOf(db, qt.id)]);
  const [sig] = await db.sql`select name, email::text as email, signed_at, ip from quote_signatures where quote_id = ${qt.id}::bigint`;
  const self = `${o.quotes}/${qt.id}`;
  const shown = COMPONENTS.filter((cpt) => !cpt.always && keys.includes(cpt.key));
  const w = o.opts.word.toLowerCase();
  const opened = opens.customer
    ? <>Opened {opens.customer === 1 ? "once" : `${opens.customer} times`}, last <When at={opens.last!} timeZone={o.timeZone} /></>
    : qt.status === "sent" && p?.link_made_at ? "Not opened yet" : null;
  const aside = [opens.scanner ? `${opens.scanner} by a mail scanner` : "", opens.team ? `${opens.team} by your team` : ""].filter(Boolean).join(", ");
  return (
    <Section title={`The ${w}`}>
      <FieldList fields={[
        { label: "Title", value: p?.title || null },
        {
          label: "Components",
          value: isEditable(qt) ? null : shown.length
            ? <>{shown.map((cpt, i) => <>{i ? ", " : ""}{cpt.label}{cpt.sample ? <SampleTag /> : null}</>)}</>
            : "None: a plain quote, its price and sign-off",
        },
        { label: "Link", value: p?.link_made_at ? <>Made <When at={p.link_made_at} timeZone={o.timeZone} />{p.emailed_at ? <>, emailed <When at={p.emailed_at} timeZone={o.timeZone} /></> : ", given by hand"}</> : null },
        { label: "Opened", value: opened ? <>{opened}{aside ? <span class="block text-label text-ink-3">Not counted: {aside}</span> : null}</> : null },
        { label: "Signed", value: sig ? <>{sig.name}, <When at={new Date(sig.signed_at)} timeZone={o.timeZone} /><span class="block text-label text-ink-3">{sig.email}{sig.ip ? `, from ${sig.ip}` : ""}</span></> : null },
        { label: "Declined", value: p?.decline_reason ? <>{p.decline_reason}{p.decline_note ? <span class="block whitespace-pre-wrap text-ink-2">{p.decline_note}</span> : null}</> : null },
      ]} />
      {isEditable(qt) ? (
        <form method="post" action={`${self}/proposal`} class="mt-5 flex flex-col gap-5 border-t border-line pt-5">
          <fieldset>
            <legend class="mb-1 font-semibold">Components</legend>
            <p class={smallText + " mb-2 text-ink-3"}>A {w} is its price and sign-off; tick what else it shows.</p>
            <ul class="flex flex-col divide-y divide-line">
              {PICKABLE.map((cpt) => (
                <li class="py-2.5">
                  <label class="flex items-start gap-3">
                    <input type="checkbox" name="components" value={cpt.key} checked={keys.includes(cpt.key)} class="mt-1 size-4" />
                    <span>
                      <span class="font-medium">{cpt.label}</span>{cpt.sample ? <SampleTag /> : null}
                      <span class={"block " + smallText + " text-ink-3"}>{cpt.shows}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div class="mt-3 rounded-control bg-panel p-4">
              <p class={smallText + " max-w-prose text-ink-2"}>
                One marked (sample) still has the starter's words. The AI writes each from your website, or from what you
                tell it, and can add a section or redesign any of them.
              </p>
              <p class={smallText + " mt-3 text-ink-2"}>Ask the AI in this app's chat:</p>
              <div class="mt-2 flex flex-col gap-2">
                <AskAi label={false} ask="Read our website and write our proposal sections from it." />
                <AskAi label={false} ask={`Add a section to our ${w}s about our warranty.`} />
                <AskAi label={false} ask={`Make our ${w}s look more like our website.`} />
              </div>
            </div>
          </fieldset>
          <label class={fieldClass}>Title<input name="title" value={p?.title ?? ""} maxlength={160} placeholder={`${o.opts.word} ${qt.number}`} class={inputClass} /></label>
          <div class="flex flex-wrap items-center gap-2">
            <button class={primaryClass}>Save</button>
            <a href={`${self}/document`} target="_blank" class={buttonClass}>Preview</a>
          </div>
        </form>
      ) : null}
      <div class="mt-4 flex flex-wrap gap-2">
        {sig ? <a href={`${self}/proposal/signed`} target="_blank" class={buttonClass}>The signed copy</a> : null}
        {qt.status === "sent" && p?.link_made_at ? (
          <form method="post" action={`${self}/proposal/link`}><button class={buttonClass}>New link</button></form>
        ) : null}
      </div>
    </Section>
  );
}

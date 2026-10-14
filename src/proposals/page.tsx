// A proposal as one self-contained HTML file: its CSS (and any fonts)
// inlined from style.ts, its pictures as data: URIs, no script. This is the
// file stored on the quote, shown in Preview, printed to the PDF, and served
// at the customer's link, where the two markers are filled: Accept's state,
// and the bar that leads to it. Nothing else is drawn when it is asked for.
import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import type { Quote } from "../invoices/quotes";
import type { SavedLine } from "../invoices/lines";
import type { TaxRate } from "../payments/tax";
import { sectionDef, type Content } from "./sections";
import { Accept, AcceptBar, type AcceptState } from "./sections/accept";
import { About } from "./sections/about";
import { Cover } from "./sections/cover";
import { Faq } from "./sections/faq";
import type { SectionProps } from "./sections/parts";
import { Pricing } from "./sections/pricing";
import { Scope } from "./sections/scope";
import { Summary } from "./sections/summary";
import { Team } from "./sections/team";
import { Terms } from "./sections/terms";
import { Testimonials } from "./sections/testimonials";
import { Timeline } from "./sections/timeline";
import { Work } from "./sections/work";
import { PROPOSAL_CSS } from "./style";

export type PageData = {
  /** What the business calls it: Quote, Proposal, Estimate. */
  word: string;
  business: string;
  timeZone: string;
  locale?: string;
  quote: Quote & { lines: SavedLine[] };
  rates: TaxRate[];
  title: string;
  /** The ticked sections in page order, placeholders filled, Cover and Pricing among them. */
  sections: { key: string; content: Content }[];
  /** Picture id to data: URI, for the pictures the sections name. */
  images: Map<string, string>;
  /** What happens when they sign, in a sentence, printed under the total. */
  afterSign: string | null;
};

const ACCEPT_MARK = "<!--tt-accept-->";
const BAR_MARK = "<!--tt-bar-->";

const COMPONENTS: Record<string, FC<SectionProps>> = {
  cover: Cover, summary: Summary, scope: Scope, pricing: Pricing, timeline: Timeline, team: Team,
  testimonials: Testimonials, work: Work, about: About, faq: Faq, terms: Terms,
};

/** The page as stored: Accept's place and the bar are markers. */
export function renderPage(d: PageData): string {
  const accept = d.sections.find((s) => s.key === "accept")?.content.title || sectionDef("accept")!.title;
  const doc = (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <meta name="referrer" content="no-referrer" />
        <title>{`${d.title}${d.business ? `, ${d.business}` : ""}`}</title>
        <style>{raw(PROPOSAL_CSS)}</style>
      </head>
      <body class="bg-canvas font-body text-body text-ink">
        <main class="mx-auto max-w-read px-5 pb-16">
          {d.sections.filter((s) => s.key in COMPONENTS).map((s) => {
            const C = COMPONENTS[s.key];
            return <C d={d} c={s.content} />;
          })}
          <section id="accept" class="border-t border-line py-12 print:break-before-page print:border-0 sm:py-16">
            <h2 class="mb-6 font-display text-section">{accept}</h2>
            {raw(ACCEPT_MARK)}
          </section>
        </main>
        {raw(BAR_MARK)}
      </body>
    </html>
  );
  return "<!doctype html>" + doc.toString();
}

/** The stored page with Accept's state drawn in, and the bar while it is open. */
export function fillPage(stored: string, state: AcceptState, word: string): string {
  const bar = state.kind === "open" ? (<AcceptBar word={word} />).toString() : "";
  return stored.replace(ACCEPT_MARK, () => (<Accept s={state} word={word} />).toString()).replace(BAR_MARK, () => bar);
}

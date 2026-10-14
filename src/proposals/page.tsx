// A proposal as one self-contained HTML file: its CSS and fonts inlined from
// style.ts, its photographs from photos.ts, no script. The quote's chosen
// components in their order, then the sign-off. This is the file stored on
// the quote, shown in Preview, printed to the PDF, and served at the
// customer's link, where the two markers are filled: the sign-off's state,
// and the bar that leads to it. Nothing else is drawn when it is asked for.
import { raw } from "hono/html";
import { COMPONENTS, type PageData } from "./components";
import { Accept, AcceptBar, type AcceptState } from "./components/signoff";
import { PROPOSAL_CSS } from "./style";

const ACCEPT_MARK = "<!--tt-accept-->";
const BAR_MARK = "<!--tt-bar-->";

/** The page as stored: the sign-off's place and the bar are markers. `keys` are the ticked components; the always-on ones are added. */
export function renderPage(d: PageData, keys: string[]): string {
  const shown = COMPONENTS.filter((c) => c.always || keys.includes(c.key));
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
        <main>
          {shown.map((c) => c.render(d))}
          <section id="accept" class="bg-panel py-20 sm:py-28 print:break-before-page">
            <div class="mx-auto max-w-read px-6 sm:px-10">
              <p class="mb-4 text-eyebrow uppercase text-accent">Next step</p>
              <h2 class="mb-10 font-display text-section">Ready to go ahead?</h2>
              {raw(ACCEPT_MARK)}
            </div>
          </section>
        </main>
        {raw(BAR_MARK)}
      </body>
    </html>
  );
  return "<!doctype html>" + doc.toString();
}

/** The stored page with the sign-off's state drawn in, and the bar while it is open. */
export function fillPage(stored: string, state: AcceptState, word: string): string {
  const bar = state.kind === "open" ? (<AcceptBar word={word} />).toString() : "";
  return stored.replace(ACCEPT_MARK, () => (<Accept s={state} word={word} />).toString()).replace(BAR_MARK, () => bar);
}

export type { PageData } from "./components";

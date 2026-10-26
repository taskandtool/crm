// A proposal as one self-contained HTML file: its CSS and fonts inlined from
// style.ts, its photographs from photos.ts, no script. The quote's chosen
// components in their order, then the sign-off. This is the file stored on
// the quote, shown in Preview, printed to the PDF, and served at the
// customer's link, where the two markers are filled: the sign-off's state,
// and the bar that leads to it. Nothing else is drawn when it is asked for.
import { raw } from "hono/html";
import { COMPONENTS, type Ground, type PageData, type View } from "./components";
import { BEFORE_SIGN } from "./components/types";
import { Masthead } from "./components/cover";
import { Accept, AcceptBar, type AcceptState } from "./components/signoff";
import { PROPOSAL_CSS } from "./style";

const ACCEPT_MARK = "<!--tt-accept-->";
const BAR_MARK = "<!--tt-bar-->";

// Bands with a ground of their own: the dark ones, and the photograph edge to edge.
const OWN_GROUND: Record<string, "night" | "photo"> = { cover: "night", reviews: "night", gallery: "photo" };

/** The page as stored: the sign-off's place and the bar are markers. `keys` are the ticked components; pricing, always on, is added. */
export function renderPage(d: PageData, keys: string[]): string {
  const ticked = COMPONENTS.filter((c) => c.always || keys.includes(c.key));
  // Only the ones that show something (a note for them needs the quote's message) count for the grounds.
  const probe: View = { ...d, ground: () => "light" };
  const shown = ticked.filter((c) => c.render(probe) !== null);
  // No cover: the page opens on the plain head, on the page's own light ground.
  const plain = !shown.some((c) => c.key === "cover");
  // Light and tinted in turn, so no two neighbours share a ground; a dark band or a photograph starts again.
  const grounds = new Map<string, Ground>();
  let prev: string = plain ? "light" : "night";
  for (const c of shown) {
    const own = OWN_GROUND[c.key];
    if (own) {
      prev = own;
      continue;
    }
    const g: Ground = prev === "light" ? "panel" : "light";
    grounds.set(c.key, g);
    prev = g;
  }
  const view: View = { ...d, ground: (key) => grounds.get(key) ?? "light" };
  const signoff = prev === "panel" ? "bg-canvas" : "bg-panel";
  const doc = (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <meta name="referrer" content="same-origin" />
        <title>{`${d.title}${d.business ? `, ${d.business}` : ""}`}</title>
        <style>{raw(PROPOSAL_CSS)}</style>
      </head>
      <body class="bg-canvas font-body text-body text-ink">
        <main>
          {plain ? <Masthead d={view} /> : null}
          {shown.map((c) => c.render(view))}
          <section id="accept" class={`${signoff} py-20 sm:py-28 print:break-before-page`}>
            <div class="mx-auto max-w-read px-6 sm:px-10">
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

const BEFORE_SIGN_BLOCK = new RegExp(`${BEFORE_SIGN.open}[\\s\\S]*?${BEFORE_SIGN.close}`, "g");

/** The stored page with the sign-off's state drawn in, the bar while it is open, and "When you sign…" only while it can be signed. */
export function fillPage(stored: string, state: AcceptState, word: string): string {
  const open = state.kind === "open" || state.kind === "preview";
  const bar = state.kind === "open" ? (<AcceptBar word={word} />).toString() : "";
  const page = open ? stored : stored.replace(BEFORE_SIGN_BLOCK, "");
  return page.replace(ACCEPT_MARK, () => (<Accept s={state} word={word} />).toString()).replace(BAR_MARK, () => bar);
}

export type { PageData } from "./components";

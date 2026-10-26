// A proposal component: a finished, designed part of the page, its words and
// photographs written into its own file from the brand record (brand/,
// public/). Registered in index.ts; the team picks them by name on a quote.
import type { Child } from "hono/jsx";
import type { Quote } from "../../invoices/quotes";
import type { SavedLine } from "../../invoices/lines";
import type { TaxRate } from "../../payments/tax";

/** What a component can read: the quote it is on, and the business. */
export type PageData = {
  /** What the business calls it: Quote, Proposal, Estimate. */
  word: string;
  business: string;
  timeZone: string;
  locale?: string;
  quote: Quote & { lines: SavedLine[] };
  rates: TaxRate[];
  /** The proposal's title (the quote's, else "<word> Q-0012"). */
  title: string;
  /** What happens when they sign, said only while they can ("When you sign, …"): gone from the signed copy. */
  beforeSign: string;
  /** What signing starts (a recurring plan), kept on the signed copy as what they agreed to. */
  agreed: string;
};

/** A light band's ground, given by the page so no two neighbours share one. */
export type Ground = "light" | "panel";
/** What a component renders with: the page's data, and the ground the page gave its band. */
export type View = PageData & { ground: (key: string) => Ground };

export type ProposalComponent = {
  key: string;
  /** Its name on the quote's checklist. */
  label: string;
  /** What it shows, in a few words, beside its name. */
  shows: string;
  /** Ticked on a new quote. */
  on: boolean;
  /** On every proposal, from the quote itself: not in the checklist. */
  always?: boolean;
  /**
   * Its words are still the starter's samples. Write them from the brand
   * record, then set this to false; until then Send says so.
   */
  sample: boolean;
  render: (d: View) => Child;
};

/** Around the words only an unsigned page says: the page fills them while it is open, and drops them once it is decided. */
export const BEFORE_SIGN = { open: "<!--tt-before-sign-->", close: "<!--/tt-before-sign-->" };

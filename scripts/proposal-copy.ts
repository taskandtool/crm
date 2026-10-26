// The proposal components' words through the tropes skill, for `npm run
// check`: every component, drawn on a made-up quote with a message and
// terms, its words checked with its title and against the others: titles,
// labels, steps, people, questions and answers. Reviews stay as written and
// are not checked; nor are a photograph's empty slot or the stars. A
// component still on its sample words is checked too: its samples are what
// a new CRM shows. Prints an error a line, "<file>: <rule> "<words>": <fix>";
// hints on stderr.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { check } from "../.claude/skills/tropes/tropes.mjs";
import { COMPONENTS, type View } from "../src/proposals/components";

const now = new Date("2026-01-15T15:00:00Z");
const view = {
  word: "Proposal", business: "The business", timeZone: "UTC", rates: [], title: "The proposal", beforeSign: "", agreed: "",
  quote: {
    id: "1", number: "Q-0001", email: "c@example.com", name: "The customer", status: "sent", currency: "usd",
    subtotal_cents: "100000", tax_cents: "0", total_cents: "100000", valid_until: null,
    // The quote's own words are the team's, not the component's: one plain sentence each, so the component's are what is checked.
    notes: "The work we talked about, at the price below.", terms: "- Prices hold for thirty days.",
    sent_at: now, created_at: now, updated_at: now, lines: [],
  },
  ground: () => "light",
} as unknown as View;

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m]);

/** A component's words, a line per block: reviews, empty photo slots, stars and the quote's own words left out. */
export function wordsOf(html: string, quoteWords: string[]): string {
  const text = html
    .replace(/<blockquote\b[\s\S]*?<\/blockquote>/g, "\n")
    .replace(/<figcaption\b[\s\S]*?<\/figcaption>/g, "\n")
    .replace(/<div\b[^>]*role="img"[\s\S]*?<\/div>/g, "\n")
    .replace(/<\/?(p|li|dd|dt|div|section|header|figure|article|ul|ol|dl|br|h[1-6]|span|summary|button|td|th|tr)\b[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, " ");
  return decode(text)
    .split("\n")
    .map((l) => l.replace(/[★☆]/g, "").replace(/\s+/g, " ").trim())
    .filter((l) => l && !quoteWords.includes(l))
    .join("\n");
}

type Finding = { rule: string; match: string; fix: string; severity: string; section?: number; sections?: [number, number] };

const quoteWords = [view.quote.notes!, view.quote.terms!.replace(/^- /, ""), view.business, view.title];
const drawn = COMPONENTS.filter((c) => !c.always).map((c) => ({ c, html: String(c.render(view) ?? "") })).filter((x) => x.html);
const sections = drawn.map(({ html }) => ({
  heading: decode((/<h[12][^>]*>([\s\S]*?)<\/h[12]>/.exec(html)?.[1] ?? "").replace(/<[^>]+>/g, "").trim()),
  body: wordsOf(html.replace(/<h[12][^>]*>[\s\S]*?<\/h[12]>/, ""), quoteWords),
}));
const file = (i: number) => `src/proposals/components/${drawn[i].c.key}.tsx`;
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const f of check(sections, { kind: "page" }) as Finding[]) {
    const where = f.section !== undefined ? file(f.section) : f.sections ? `${file(f.sections[1])} (and ${file(f.sections[0])})` : "the components";
    const line = `${where}: ${f.rule} "${f.match.slice(0, 60)}": ${f.fix}`;
    if (f.severity === "error") console.log(line);
    else console.error(`hint: ${line}`);
  }
}

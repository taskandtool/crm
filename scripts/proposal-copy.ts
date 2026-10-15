// The proposal components' words through the tropes skill, for `npm run
// check`: each one written from the brand record (sample: false) is drawn on
// a made-up quote, and its words are checked with its title and against the
// others. Reviews and their names stay as written, and the quote's own
// words (its message, its terms, its lines) are not the components'.
// Prints an error a line, "<file>: <rule> "<words>": <fix>"; hints on stderr.
import { check } from "../.claude/skills/tropes/tropes.mjs";
import { COMPONENTS, type View } from "../src/proposals/components";

const now = new Date("2026-01-15T15:00:00Z");
const view = {
  word: "Proposal", business: "The business", timeZone: "UTC", rates: [], title: "The proposal", afterSign: "",
  quote: {
    id: "1", number: "Q-0001", email: "c@example.com", name: "The customer", status: "sent", currency: "usd",
    subtotal_cents: "100000", tax_cents: "0", total_cents: "100000", valid_until: null, notes: null, terms: null,
    sent_at: now, created_at: now, updated_at: now, lines: [],
  },
  ground: () => "light",
} as unknown as View;

const text = (html: string) =>
  html.replace(/<(h[1-6]|dt|blockquote|figcaption|button|summary)\b[\s\S]*?<\/\1>/g, "\n")
    .replace(/<\/?(p|li|dd|div|section|header|figure|article|ul|ol|dl|br)\b[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");

const written = COMPONENTS.filter((c) => !c.sample && !c.always);
const drawn = written.map((c) => ({ c, html: String(c.render(view) ?? "") })).filter((x) => x.html);
const sections = drawn.map(({ html }) => ({
  heading: (/<h[12][^>]*>([\s\S]*?)<\/h[12]>/.exec(html)?.[1] ?? "").replace(/<[^>]+>/g, "").trim(),
  body: text(html),
}));
const file = (i: number) => `src/proposals/components/${drawn[i].c.key}.tsx`;
type Finding = { rule: string; match: string; fix: string; severity: string; section?: number; sections?: [number, number] };
for (const f of check(sections, { kind: "page" }) as Finding[]) {
  const where = f.section !== undefined ? file(f.section) : f.sections ? `${file(f.sections[1])} (and ${file(f.sections[0])})` : "the components";
  const line = `${where}: ${f.rule} "${f.match.slice(0, 60)}": ${f.fix}`;
  if (f.severity === "error") console.log(line);
  else console.error(`hint: ${line}`);
}

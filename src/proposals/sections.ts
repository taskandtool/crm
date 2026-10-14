// The sections a proposal is built from, in the order every proposal has
// them. Cover, Pricing and Accept are always there; the rest are ticked.
// Each has a standing title, named texts (Markdown) and, for some, entries
// (rows of fields). A new section is a row here, its component in
// sections/<key>.tsx, and its place in page.tsx.
//
// The words here are the defaults a library starts with; the owner rewords
// them in Settings > Proposal sections, and per quote.

export type FieldKind = "text" | "long" | "image" | "rating";
export type Field = { name: string; label: string; kind: FieldKind; max: number };
export type SectionDef = {
  key: string;
  label: string;
  /** On every proposal: not in the checklist. */
  always?: boolean;
  /** Ticked on a new quote until the library says otherwise. */
  ticked: boolean;
  title: string;
  /** What the section shows, for the checklist. */
  shows: string;
  texts: { name: string; label: string; hint?: string }[];
  entries?: { one: string; many: string; fields: Field[]; max: number };
};

const text = (name: string, label: string, max = 200): Field => ({ name, label, kind: "text", max });
const long = (name: string, label: string, max = 2000): Field => ({ name, label, kind: "long", max });
const image = (name: string, label: string): Field => ({ name, label, kind: "image", max: 20 });

export const SECTIONS: SectionDef[] = [
  { key: "cover", label: "Cover", always: true, ticked: true, title: "", shows: "Your logo and name, the customer, the title, the date and how long it is open",
    texts: [], entries: { one: "Logo", many: "Logo", max: 1, fields: [image("logo", "Logo")] } },
  { key: "summary", label: "Summary", ticked: true, title: "Summary", shows: "What we heard, and what we propose",
    texts: [
      { name: "heard", label: "What we heard", hint: "Their situation and what they asked for, in their words." },
      { name: "propose", label: "What we propose", hint: "What you will do about it, in a few sentences." },
    ] },
  { key: "scope", label: "Scope", ticked: true, title: "Scope", shows: "What is included, and what is not",
    texts: [
      { name: "included", label: "Included", hint: "A list: one line per item, each starting with a dash." },
      { name: "excluded", label: "Not included", hint: "What they might assume and should not." },
    ] },
  { key: "pricing", label: "Pricing", always: true, ticked: true, title: "Pricing", shows: "The lines, tax, totals, and what happens when they sign",
    texts: [{ name: "intro", label: "A line above the prices", hint: "Optional." }] },
  { key: "timeline", label: "Timeline", ticked: false, title: "Timeline", shows: "The steps, with dates or how long each takes",
    texts: [],
    entries: { one: "Step", many: "Steps", max: 20, fields: [text("step", "Step"), text("when", "When", 60), long("detail", "Detail", 600)] } },
  { key: "team", label: "Team", ticked: false, title: "Your team", shows: "Who does the work: photo, name, role and one line",
    texts: [],
    entries: { one: "Person", many: "People", max: 12, fields: [image("photo", "Photo"), text("name", "Name", 120), text("role", "Role", 120), text("line", "One line", 240)] } },
  { key: "testimonials", label: "Testimonials", ticked: false, title: "What our customers say", shows: "Quotes from customers, with their rating",
    texts: [],
    entries: { one: "Testimonial", many: "Testimonials", max: 12, fields: [long("quote", "What they said", 800), text("name", "Name", 120), text("company", "Company", 120), { name: "rating", label: "Stars (1 to 5)", kind: "rating", max: 1 }] } },
  { key: "work", label: "Our work", ticked: false, title: "Work we have done", shows: "Case studies: a picture, a title and the result",
    texts: [],
    entries: { one: "Case study", many: "Case studies", max: 12, fields: [image("image", "Picture"), text("title", "Title", 160), long("result", "The result", 600)] } },
  { key: "about", label: "About us", ticked: false, title: "About us", shows: "The business in a paragraph, and a few numbers",
    texts: [{ name: "about", label: "About the business" }],
    entries: { one: "Number", many: "Numbers", max: 6, fields: [text("figure", "Figure", 20), text("label", "What it counts", 80)] } },
  { key: "faq", label: "Questions", ticked: false, title: "Questions", shows: "Questions customers ask, and the answers",
    texts: [],
    entries: { one: "Question", many: "Questions", max: 20, fields: [text("question", "Question", 240), long("answer", "Answer", 1500)] } },
  { key: "terms", label: "Terms", ticked: true, title: "Terms", shows: "The terms they agree to by signing",
    texts: [{ name: "terms", label: "Terms" }] },
  { key: "accept", label: "Accept", always: true, ticked: true, title: "Accept", shows: "Their typed name, the agree box and Accept; once signed, the signature",
    texts: [] },
];

export const sectionDef = (key: string): SectionDef | undefined => SECTIONS.find((s) => s.key === key);
/** The ones a person ticks; the rest are always on. */
export const TICKABLE = SECTIONS.filter((s) => !s.always);

export type Entry = Record<string, string>;
/** A section's content: its title, texts by name, entries. */
export type Content = { title: string; texts: Record<string, string>; entries: Entry[] };

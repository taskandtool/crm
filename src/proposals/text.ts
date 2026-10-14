// A proposal's words: the placeholders that fill in each quote's own facts,
// and the small Markdown the owner writes them in. Everything is escaped;
// raw HTML never passes through, since the page shares a host with the
// team's CRM.
//
//   fill("Thanks, {customer}.", { customer: "Ann Lee" })   // "Thanks, Ann Lee."
//   unknownPlaceholders("Hi {client}")                      // ["{client}"]
//   markdown("- Gate\n- **Posts**")                         // "<ul><li>Gate</li><li><strong>Posts</strong></li></ul>"

/** The placeholders a library text may use, and what each is. */
export const PLACEHOLDERS: Record<string, string> = {
  customer: "the customer's name, else their email",
  business: "your business's name",
  total: "the quote's total",
  valid_until: "the date it is open until",
  number: "the quote's number, Q-0012",
};

export type Facts = Record<keyof typeof PLACEHOLDERS, string>;

const TOKEN = /\{([a-z_]+)\}/g;

/** Each placeholder replaced by its fact; anything else in braces is left as written. */
export function fill(text: string, facts: Partial<Facts>): string {
  return text.replace(TOKEN, (whole, name: string) => (name in PLACEHOLDERS ? (facts as Record<string, string>)[name] ?? "" : whole));
}

/** Braced words that are not placeholders: said to the owner on save, never sent as written. */
export function unknownPlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[1]).filter((n) => !(n in PLACEHOLDERS)).map((n) => `{${n}}`))];
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** **bold** and [words](https://...) inside a line; the link only to http, https or mailto. */
function inline(line: string): string {
  let out = "";
  let rest = line;
  const LINK = /\[([^\]]{1,200})\]\(((?:https?:\/\/|mailto:)[^\s)]{1,500})\)/;
  for (;;) {
    const m = LINK.exec(rest);
    if (!m) break;
    out += bold(escapeHtml(rest.slice(0, m.index))) + `<a href="${escapeHtml(m[2])}" rel="noopener noreferrer">${bold(escapeHtml(m[1]))}</a>`;
    rest = rest.slice(m.index + m[0].length);
  }
  return out + bold(escapeHtml(rest));
}
const bold = (escaped: string) => escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

/**
 * Paragraphs (a blank line between), lists (lines starting "- ", "* " or
 * "1. "), **bold** and links. A single line break inside a paragraph is
 * kept.
 */
export function markdown(src: string): string {
  const blocks = src.replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/);
  return blocks
    .map((block) => {
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return "";
      const bullet = lines.every((l) => /^[-*]\s+/.test(l));
      const numbered = lines.every((l) => /^\d{1,3}[.)]\s+/.test(l));
      if (bullet || numbered) {
        const tag = bullet ? "ul" : "ol";
        return `<${tag}>${lines.map((l) => `<li>${inline(l.replace(/^([-*]|\d{1,3}[.)])\s+/, ""))}</li>`).join("")}</${tag}>`;
      }
      return `<p>${lines.map(inline).join("<br/>")}</p>`;
    })
    .join("");
}

/** The text with no Markdown left, for a line where markup does not belong (a title, a summary). */
export const plain = (src: string) => src.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

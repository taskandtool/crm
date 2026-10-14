// What every section shares: its frame (space and a hairline above, never a
// card), its title, and the owner's Markdown.
import type { Child } from "hono/jsx";
import type { Content, Entry } from "../sections";
import { markdown } from "../text";
import type { PageData } from "../page";

export type SectionProps = { d: PageData; c: Content };

/** One section: a new page in print, a hairline and space on screen. */
export function Frame({ id, title, children }: { id: string; title?: string; children: Child }) {
  return (
    <section id={id} class="border-t border-line py-12 print:break-before-page print:border-0 sm:py-16">
      {title ? <h2 class="mb-6 font-display text-section">{title}</h2> : null}
      {children}
    </section>
  );
}

/** The owner's Markdown, escaped and rendered (text.ts). */
export function Prose({ src, class: cls }: { src: string; class?: string }) {
  return src.trim() ? <div class={"prose " + (cls ?? "text-body")} dangerouslySetInnerHTML={{ __html: markdown(src) }} /> : null;
}

/** A picture from the proposal's images, by id, inlined; nothing when it is gone. */
export function Picture({ d, id, alt, class: cls }: { d: PageData; id: string | undefined; alt: string; class: string }) {
  const src = id ? d.images.get(id) : undefined;
  return src ? <img src={src} alt={alt} class={cls} /> : null;
}

/** Entries with something in them. */
export const filled = (entries: Entry[]) => entries.filter((e) => Object.values(e).some((v) => typeof v === "string" && v.trim()));

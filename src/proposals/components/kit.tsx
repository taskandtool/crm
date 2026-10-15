// What every component is made of: a full-width band in one of three
// grounds, the page's column, a heading, a photograph (or
// the slot it fills until there is one) and stars. Change the look here and
// in styles/proposal.css, not in each component.
import type { Child } from "hono/jsx";
import { PHOTOS } from "../photos";

type Tone = "light" | "panel" | "night";

const GROUND: Record<Tone, string> = {
  light: "bg-canvas text-ink",
  panel: "bg-panel text-ink",
  night: "bg-night text-night-ink",
};

/** One component's band, edge to edge: a new page in print. */
export function Band({ id, tone = "light", children, tight }: { id: string; tone?: Tone; children: Child; tight?: boolean }) {
  return (
    <section id={id} class={`${GROUND[tone]} ${tight ? "py-14 sm:py-16" : "py-20 sm:py-28"} print:break-before-page`}>
      {children}
    </section>
  );
}

/** The page's column. */
export const Inner = ({ children }: { children: Child }) => <div class="mx-auto max-w-page px-6 sm:px-10">{children}</div>;

/** A component's title, and the line under it when it has one. */
export function Heading({ title, children }: { title: string; children?: Child }) {
  return (
    <div class="max-w-read">
      <h2 class="font-display text-section">{title}</h2>
      {children ? <div class="mt-6 text-lede text-muted">{children}</div> : null}
    </div>
  );
}

/**
 * A photograph from the brand record by its path, brand/images/<file>, built
 * into the page: scripts/proposal-build.mjs inlines every one the components
 * name. Null for an empty path, or one not built in.
 */
export const photo = (path: string): string | null => PHOTOS[path] ?? null;

/** A photograph, or the slot it fills until there is one: says what belongs there, on either light ground. */
export function Picture({ src, alt, label, class: cls }: { src: string | null; alt: string; label: string; class: string }) {
  if (src) return <img src={src} alt={alt} class={`${cls} object-cover`} />;
  return (
    <div class={`${cls} flex items-end border border-dashed border-line-strong text-muted p-5`} role="img" aria-label={label}>
      <span class="text-small">{label}</span>
    </div>
  );
}

/** Stars out of five, in the accent colour. */
export function Stars({ n, night }: { n: number; night?: boolean }) {
  const k = Math.max(0, Math.min(5, Math.round(n)));
  return (
    <p class="text-small text-accent" aria-label={`${k} out of 5 stars`}>
      {"★".repeat(k)}
      <span class={night ? "text-line-night" : "text-line-strong"}>{"★".repeat(5 - k)}</span>
    </p>
  );
}

/** Text with its line breaks and "- " lines as a list, escaped by JSX. */
export function Lines({ text, class: cls }: { text: string; class?: string }) {
  const blocks = text.replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/);
  return (
    <div class={`flex flex-col gap-4 ${cls ?? ""}`}>
      {blocks.map((b) => {
        const lines = b.split("\n").map((l) => l.trim()).filter(Boolean);
        return lines.every((l) => /^[-*]\s+/.test(l))
          ? <ul class="flex list-disc flex-col gap-1.5 pl-5">{lines.map((l) => <li>{l.replace(/^[-*]\s+/, "")}</li>)}</ul>
          : <p>{lines.map((l, i) => <>{i ? <br /> : null}{l}</>)}</p>;
      })}
    </div>
  );
}

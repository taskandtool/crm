// Customers in their own words, with their stars.
import { Frame, filled, type SectionProps } from "./parts";

export function Testimonials({ c }: SectionProps) {
  const quotes = filled(c.entries).filter((e) => e.quote?.trim());
  if (!quotes.length) return null;
  return (
    <Frame id="testimonials" title={c.title}>
      <div class="flex flex-col gap-10">
        {quotes.map((t) => {
          const stars = Math.max(0, Math.min(5, Number(t.rating) || 0));
          return (
            <figure class="print:break-inside-avoid">
              {stars ? <p class="mb-3 text-small text-accent" aria-label={`${stars} out of 5 stars`}>{"★".repeat(stars)}<span class="text-line-strong">{"★".repeat(5 - stars)}</span></p> : null}
              <blockquote class="whitespace-pre-line text-lede">{t.quote}</blockquote>
              {t.name || t.company ? <figcaption class="mt-3 text-small text-muted">{[t.name, t.company].filter(Boolean).join(", ")}</figcaption> : null}
            </figure>
          );
        })}
      </div>
    </Frame>
  );
}

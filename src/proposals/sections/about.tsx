// The business in a paragraph and a few numbers.
import { Frame, Prose, filled, type SectionProps } from "./parts";

export function About({ c }: SectionProps) {
  const about = c.texts.about ?? "";
  const numbers = filled(c.entries).filter((n) => n.figure?.trim());
  if (!about.trim() && !numbers.length) return null;
  return (
    <Frame id="about" title={c.title}>
      <Prose src={about} />
      {numbers.length ? (
        <dl class="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3">
          {numbers.map((n) => (
            <div>
              <dd class="font-display text-total">{n.figure}</dd>
              <dt class="mt-1 text-small text-muted">{n.label}</dt>
            </div>
          ))}
        </dl>
      ) : null}
    </Frame>
  );
}

// Case studies: a picture, what it was, and what came of it.
import { Frame, Picture, filled, type SectionProps } from "./parts";

export function Work({ d, c }: SectionProps) {
  const cases = filled(c.entries);
  if (!cases.length) return null;
  return (
    <Frame id="work" title={c.title}>
      <div class="flex flex-col gap-10">
        {cases.map((w) => (
          <article class="print:break-inside-avoid">
            <Picture d={d} id={w.image} alt={w.title ?? ""} class="mb-4 aspect-[16/9] w-full rounded-box bg-panel object-cover" />
            <h3 class="text-body font-semibold">{w.title}</h3>
            {w.result ? <p class="mt-1 whitespace-pre-line text-body text-muted">{w.result}</p> : null}
          </article>
        ))}
      </div>
    </Frame>
  );
}

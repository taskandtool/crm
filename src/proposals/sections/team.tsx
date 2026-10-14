// Who does the work.
import { Frame, Picture, filled, type SectionProps } from "./parts";

export function Team({ d, c }: SectionProps) {
  const people = filled(c.entries);
  if (!people.length) return null;
  return (
    <Frame id="team" title={c.title}>
      <ul class="grid gap-8 sm:grid-cols-2">
        {people.map((p) => (
          <li class="flex gap-4 print:break-inside-avoid">
            <Picture d={d} id={p.photo} alt={p.name ?? ""} class="size-16 shrink-0 rounded-full bg-panel object-cover" />
            <div>
              <p class="text-body font-semibold">{p.name}</p>
              {p.role ? <p class="text-small text-muted">{p.role}</p> : null}
              {p.line ? <p class="mt-2 text-small">{p.line}</p> : null}
            </div>
          </li>
        ))}
      </ul>
    </Frame>
  );
}

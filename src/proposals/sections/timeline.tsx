// The steps, in order, with when each happens.
import { Frame, filled, type SectionProps } from "./parts";

export function Timeline({ c }: SectionProps) {
  const steps = filled(c.entries);
  if (!steps.length) return null;
  return (
    <Frame id="timeline" title={c.title}>
      <ol class="flex flex-col">
        {steps.map((s, i) => (
          <li class="grid grid-cols-[2rem_1fr] gap-x-4 border-b border-line py-4 last:border-0 print:break-inside-avoid sm:grid-cols-[2rem_1fr_9rem]">
            <span class="text-small text-muted tabular-nums">{String(i + 1).padStart(2, "0")}</span>
            <div>
              <p class="text-body font-semibold">{s.step}</p>
              {s.detail ? <p class="mt-1 whitespace-pre-line text-small text-muted">{s.detail}</p> : null}
            </div>
            {s.when ? <p class="col-start-2 mt-1 text-small text-muted sm:col-start-3 sm:mt-0 sm:text-right">{s.when}</p> : null}
          </li>
        ))}
      </ol>
    </Frame>
  );
}

// The questions customers ask, open on the page and in print.
import { Frame, filled, type SectionProps } from "./parts";

export function Faq({ c }: SectionProps) {
  const items = filled(c.entries).filter((q) => q.question?.trim());
  if (!items.length) return null;
  return (
    <Frame id="faq" title={c.title}>
      <dl class="flex flex-col gap-6">
        {items.map((q) => (
          <div class="print:break-inside-avoid">
            <dt class="text-body font-semibold">{q.question}</dt>
            {q.answer ? <dd class="mt-1 whitespace-pre-line text-body text-muted">{q.answer}</dd> : null}
          </div>
        ))}
      </dl>
    </Frame>
  );
}

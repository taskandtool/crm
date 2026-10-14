// What is included, and what is not: side by side on a wide screen.
import { Frame, Prose, type SectionProps } from "./parts";

export function Scope({ c }: SectionProps) {
  const inc = c.texts.included ?? "", exc = c.texts.excluded ?? "";
  if (!inc.trim() && !exc.trim()) return null;
  return (
    <Frame id="scope" title={c.title}>
      <div class="grid gap-8 sm:grid-cols-2">
        {inc.trim() ? <div><h3 class="mb-2 text-label uppercase text-muted">Included</h3><Prose src={inc} /></div> : null}
        {exc.trim() ? <div><h3 class="mb-2 text-label uppercase text-muted">Not included</h3><Prose src={exc} class="text-body text-muted" /></div> : null}
      </div>
    </Frame>
  );
}

// What we heard, and what we propose.
import { Frame, Prose, type SectionProps } from "./parts";

export function Summary({ c }: SectionProps) {
  const heard = c.texts.heard ?? "", propose = c.texts.propose ?? "";
  if (!heard.trim() && !propose.trim()) return null;
  return (
    <Frame id="summary" title={c.title}>
      <div class="flex flex-col gap-8">
        {heard.trim() ? <div><h3 class="mb-2 text-label uppercase text-muted">What we heard</h3><Prose src={heard} class="text-lede" /></div> : null}
        {propose.trim() ? <div><h3 class="mb-2 text-label uppercase text-muted">What we propose</h3><Prose src={propose} class="text-lede" /></div> : null}
      </div>
    </Frame>
  );
}

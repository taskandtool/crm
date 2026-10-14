// The terms they agree to by signing.
import { Frame, Prose, type SectionProps } from "./parts";

export function Terms({ c }: SectionProps) {
  const terms = c.texts.terms ?? "";
  if (!terms.trim()) return null;
  return (
    <Frame id="terms" title={c.title}>
      <Prose src={terms} class="text-small" />
    </Frame>
  );
}

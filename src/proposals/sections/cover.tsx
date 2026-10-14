// The first screen: who it is from, what it is, who it is for, and its dates.
import { dayText, todayIn } from "../../invoices/document";
import { Picture, type SectionProps } from "./parts";

export function Cover({ d, c }: SectionProps) {
  const q = d.quote;
  const logo = c.entries[0]?.logo;
  const day = todayIn(d.timeZone, q.sent_at ?? q.created_at);
  return (
    <header class="pb-12 pt-10 sm:pb-16 sm:pt-16">
      <div class="mb-16 flex items-center gap-3 sm:mb-24">
        <Picture d={d} id={logo} alt={d.business || "Logo"} class="h-10 w-auto max-w-48 object-contain" />
        {d.business ? <span class="text-small font-semibold">{d.business}</span> : null}
      </div>
      <p class="mb-4 text-label uppercase text-muted">{d.word} {q.number}</p>
      <h1 class="font-display text-display">{d.title}</h1>
      <dl class="mt-10 grid gap-x-8 gap-y-4 text-small sm:grid-cols-3">
        <div>
          <dt class="text-label uppercase text-muted">Prepared for</dt>
          <dd class="mt-1">{q.name ?? q.email}</dd>
        </div>
        <div>
          <dt class="text-label uppercase text-muted">Date</dt>
          <dd class="mt-1">{dayText(day, d.locale)}</dd>
        </div>
        {q.valid_until ? (
          <div>
            <dt class="text-label uppercase text-muted">Open until</dt>
            <dd class="mt-1">{dayText(q.valid_until, d.locale)}</dd>
          </div>
        ) : null}
      </dl>
    </header>
  );
}

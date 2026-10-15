// The cover: the business's best photograph edge to edge, darkened so the
// title reads; the dark ground until there is one. The quote gives the
// title, who it is for and its dates.
import { dayText, todayIn } from "../../invoices/document";
import { Picture, photo } from "./kit";
import type { ProposalComponent } from "./types";

// From brand/images.md: the photograph that says the most about the work, wide.
const COVER = photo("");
// From brand/logo/: the logo, on dark (a light version where there are two).
const LOGO = photo("");

export const cover: ProposalComponent = {
  key: "cover", label: "Cover", shows: "A full-page photograph, the title, who it is for and its dates", on: true, always: true, sample: false,
  render: (d) => {
    const q = d.quote;
    const day = dayText(todayIn(d.timeZone, q.sent_at ?? q.created_at), d.locale);
    return (
      <header class="relative flex min-h-screen flex-col bg-night text-night-ink print:min-h-[100vh]">
        {COVER ? <Picture src={COVER} alt="" label="" class="absolute inset-0 size-full" /> : null}
        {COVER ? <div class="absolute inset-0 bg-night/55" /> : (
          <p class="absolute right-6 top-24 text-small text-night-muted sm:right-10 print:hidden">Your best photograph goes here, edge to edge</p>
        )}
        <div class="relative mx-auto flex w-full max-w-page flex-1 flex-col px-6 py-8 sm:px-10 sm:py-10">
          <div class="flex items-center justify-between gap-6">
            {LOGO ? <img src={LOGO} alt={d.business} class="h-10 w-auto max-w-56 object-contain" /> : <span class="text-title">{d.business}</span>}
            <span class="text-eyebrow uppercase text-night-muted">{d.word} {q.number}</span>
          </div>
          <div class="mt-auto pb-20 pt-24 print:pb-6">
            <h1 class="max-w-4xl font-display text-hero">{d.title}</h1>
            <dl class="mt-12 grid max-w-4xl grid-cols-2 gap-6 border-t border-line-night pt-6 text-small sm:grid-cols-4">
              <div><dt class="text-night-muted">For</dt><dd class="mt-1">{q.name ?? q.email}</dd></div>
              <div><dt class="text-night-muted">From</dt><dd class="mt-1">{d.business || "Us"}</dd></div>
              <div><dt class="text-night-muted">Date</dt><dd class="mt-1">{day}</dd></div>
              {q.valid_until ? <div><dt class="text-night-muted">Open until</dt><dd class="mt-1">{dayText(q.valid_until, d.locale)}</dd></div> : null}
            </dl>
          </div>
        </div>
      </header>
    );
  },
};

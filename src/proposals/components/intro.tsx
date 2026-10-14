// A note for them: the quote's own message (its "Message to the customer"),
// set large. Nothing when the quote has none.
import { Band, Inner, Lines } from "./kit";
import type { ProposalComponent } from "./types";

export const intro: ProposalComponent = {
  key: "intro", label: "A note for them", shows: "The quote's message, written for this customer", on: true, sample: false,
  render: (d) => {
    const note = d.quote.notes?.trim();
    if (!note) return null;
    return (
      <Band id="intro">
        <Inner>
          <div class="grid gap-10 md:grid-cols-12">
            <p class="text-eyebrow uppercase text-accent md:col-span-4">A note for you</p>
            <div class="md:col-span-8">
              <Lines text={note} class="text-lede" />
              {d.business ? <p class="mt-10 text-small text-muted">{d.business}</p> : null}
            </div>
          </div>
        </Inner>
      </Band>
    );
  },
};

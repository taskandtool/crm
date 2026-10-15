// The letter: the quote's own message (its "Message to the customer") as a
// letter to them, their first name first and the business's name under it.
// Nothing when the quote has none.
import { Band, Inner, Lines } from "./kit";
import type { ProposalComponent } from "./types";

export const intro: ProposalComponent = {
  key: "intro", label: "Letter", shows: "The quote's message, as a letter to them", on: true, sample: false,
  render: (d) => {
    const note = d.quote.notes?.trim();
    if (!note) return null;
    const first = d.quote.name?.trim().split(/\s+/)[0];
    return (
      <Band id="intro" tone={d.ground("intro")}>
        <Inner>
          <div class="max-w-read">
            {first ? <p class="mb-6 text-lede">Dear {first},</p> : null}
            <Lines text={note} class="text-lede" />
            {d.business ? <p class="mt-10 text-lede">{d.business}</p> : null}
          </div>
        </Inner>
      </Band>
    );
  },
};

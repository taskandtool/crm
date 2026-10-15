// The terms they agree to by signing: the quote's own (crm.config.json's
// invoices.terms, changed on the quote). Nothing when it has none.
import { Band, Heading, Inner, Lines } from "./kit";
import type { ProposalComponent } from "./types";

export const terms: ProposalComponent = {
  key: "terms", label: "Terms", shows: "The quote's terms, which they agree to by signing", on: true, sample: false,
  render: (d) => {
    const t = d.quote.terms?.trim();
    if (!t) return null;
    return (
      <Band id="terms" tone={d.ground("terms")} tight>
        <Inner>
          <div class="grid gap-10 md:grid-cols-12">
            <div class="md:col-span-4"><Heading title="Terms" /></div>
            <Lines text={t} class="text-small text-muted md:col-span-8" />
          </div>
        </Inner>
      </Band>
    );
  },
};

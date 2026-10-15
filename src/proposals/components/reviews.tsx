// What customers say: one review set large on the dark ground, two more
// beside it. Verbatim from public/proof.md, with who said it and where;
// never written by us.
import { Band, Inner, Stars } from "./kit";
import type { ProposalComponent } from "./types";

const FEATURED = {
  quote: "A review from one of your customers goes here, word for word, from your website or your Google listing.",
  name: "Customer name", where: "Google review", stars: 5,
};
const MORE = [
  { quote: "A second review, short and specific about the work.", name: "Customer name", where: "Their company", stars: 5 },
  { quote: "A third, ideally about something like this job.", name: "Customer name", where: "Their town", stars: 5 },
];
// The rating, its count and its source, from public/proof.md; null when no source states all three.
const RATING: { stars: number; count: string; source: string } | null = { stars: 4.9, count: "120 reviews", source: "Google" };

export const reviews: ProposalComponent = {
  key: "reviews", label: "Reviews", shows: "What customers say, with their stars", on: false, sample: true,
  render: () => (
    <Band id="reviews" tone="night">
      <Inner>
        {RATING ? (
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Stars n={RATING.stars} night />
            <p class="text-small text-night-muted">{RATING.stars} from {RATING.count} on {RATING.source}</p>
          </div>
        ) : <Stars n={FEATURED.stars} night />}
        <figure class="mt-10 max-w-4xl">
          <blockquote class="font-display text-quote">“{FEATURED.quote}”</blockquote>
          <figcaption class="mt-8 text-small text-night-muted">{FEATURED.name}, {FEATURED.where}</figcaption>
        </figure>
        <div class="mt-16 grid gap-10 border-t border-line-night pt-10 md:grid-cols-2">
          {MORE.map((r) => (
            <figure>
              <Stars n={r.stars} night />
              <blockquote class="mt-4 text-lede">“{r.quote}”</blockquote>
              <figcaption class="mt-4 text-small text-night-muted">{r.name}, {r.where}</figcaption>
            </figure>
          ))}
        </div>
      </Inner>
    </Band>
  ),
};

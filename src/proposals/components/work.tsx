// Work we've done: case studies as photographs with what came of each. From
// the business's own projects (public/proof.md, brand/images.md).
import { Band, Heading, Inner, Picture, photo } from "./kit";
import type { ProposalComponent } from "./types";

const CASES = [
  { client: "Client or place", title: "A job like this one", result: "1 day", note: "Sample words: what was done, and what came of it.", photo: photo("") },
  { client: "Client or place", title: "Another job worth showing", result: "30%", note: "A result in their numbers: time, savings, a rating.", photo: photo("") },
];

export const work: ProposalComponent = {
  key: "work", label: "Our work", shows: "Case studies: a photograph, the job and its result", on: false, sample: true,
  render: () => (
    <Band id="work" tone="panel">
      <Inner>
        <Heading eyebrow="Our work" title="Jobs like yours" />
        <div class="mt-16 grid gap-12 md:grid-cols-2">
          {CASES.map((c) => (
            <article>
              <Picture src={c.photo} alt={c.title} label="A photograph of the finished job" class="aspect-[3/2] w-full rounded-box" />
              <p class="mt-6 text-eyebrow uppercase text-accent">{c.client}</p>
              <h3 class="mt-3 text-title">{c.title}</h3>
              <div class="mt-6 border-t border-line-strong pt-6">
                <p class="whitespace-nowrap font-display text-figure">{c.result}</p>
                <p class="mt-3 max-w-sm text-small text-muted">{c.note}</p>
              </div>
            </article>
          ))}
        </div>
      </Inner>
    </Band>
  ),
};

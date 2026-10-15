// Work we've done: case studies as photographs with what came of each. From
// the business's own projects (public/proof.md, brand/images.md). A result
// only where a source states one.
import { Band, Heading, Inner, Picture, photo } from "./kit";
import type { ProposalComponent } from "./types";

const CASES: { client: string; title: string; result?: string; note: string; photo: string | null }[] = [
  { client: "Client or place", title: "A job like this one", result: "1 day", note: "Sample words: what was done, and what came of it.", photo: photo("") },
  { client: "Their town", title: "Another job worth showing", result: "30%", note: "A result in their numbers: time, savings, a rating.", photo: photo("") },
];

export const work: ProposalComponent = {
  key: "work", label: "Our work", shows: "Case studies: a photograph, the job and its result", on: false, sample: true,
  render: (d) => (
    <Band id="work" tone={d.ground("work")}>
      <Inner>
        <Heading title="Jobs like yours" />
        <div class="mt-16 grid gap-12 md:grid-cols-2">
          {CASES.map((c) => (
            <article>
              <Picture src={c.photo} alt={c.title} label="The finished job" class="aspect-[3/2] w-full rounded-box" />
              <p class="mt-6 text-small text-muted">{c.client}</p>
              <h3 class="mt-1 text-title">{c.title}</h3>
              <div class="mt-6 border-t border-line-strong pt-6">
                {c.result ? <p class="mb-3 whitespace-nowrap font-display text-figure">{c.result}</p> : null}
                <p class="max-w-sm text-small text-muted">{c.note}</p>
              </div>
            </article>
          ))}
        </div>
      </Inner>
    </Band>
  ),
};

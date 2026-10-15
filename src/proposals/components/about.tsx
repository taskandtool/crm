// About us: the business in a photograph, two short paragraphs and three
// figures. Words from public/business.md; the photograph from brand/images.md.
import { Band, Heading, Inner, Picture, photo } from "./kit";
import type { ProposalComponent } from "./types";

const PHOTO = photo("");
// Sample words: the business in one line, as the business says it.
const TITLE = "About us";
const WORDS = [
  "Sample words: two or three sentences about the business, how long it has done this work, who it works for and what it promises.",
  "The AI writes them from your website, in your own voice, and keeps every fact to what a source says.",
];
// Stated figures only, each from a source: years in business, jobs done, a rating with its count.
const FIGURES = [
  { figure: "15", label: "years in business" },
  { figure: "2,400", label: "jobs completed" },
  { figure: "4.9", label: "average rating" },
];

export const about: ProposalComponent = {
  key: "about", label: "About us", shows: "The business in a photograph, a few lines and three figures", on: false, sample: true,
  render: (d) => (
    <Band id="about" tone={d.ground("about")}>
      <Inner>
        <div class="grid items-center gap-12 md:grid-cols-2 md:gap-20">
          <Picture src={PHOTO} alt="" label="The team or the work" class="aspect-[4/5] w-full rounded-box" />
          <div>
            <Heading title={TITLE} />
            <div class="mt-6 flex flex-col gap-4 text-body text-muted">{WORDS.map((w) => <p>{w}</p>)}</div>
            <dl class="mt-12 grid grid-cols-3 gap-6 border-t border-line pt-8">
              {FIGURES.map((f) => (
                <div class="flex flex-col-reverse"><dt class="mt-2 text-small text-muted">{f.label}</dt><dd class="font-display text-stat">{f.figure}</dd></div>
              ))}
            </dl>
          </div>
        </div>
      </Inner>
    </Band>
  ),
};

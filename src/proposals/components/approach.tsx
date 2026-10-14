// How we'll do it: the work in four numbered steps. From public/services.md
// (how the business works), in its own words.
import { Band, Heading, Inner } from "./kit";
import type { ProposalComponent } from "./types";

const STEPS = [
  { title: "We look first", text: "Sample words: a visit to measure, check and photograph everything before a price is final." },
  { title: "You approve the plan", text: "One written plan with the date, the crew and what the day looks like." },
  { title: "We do the work", text: "On the day we said, with the site kept clean and you told of anything we find." },
  { title: "We walk you through it", text: "A walkthrough at the end, and the warranty registered in your name." },
];

export const approach: ProposalComponent = {
  key: "approach", label: "How we'll do it", shows: "The work in four numbered steps", on: true, sample: true,
  render: () => (
    <Band id="approach" tone="panel">
      <Inner>
        <Heading eyebrow="Our approach" title="How we'll do it" />
        <ol class="mt-16 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li class="border-t border-line-strong pt-6">
              <span class="font-display text-figure text-accent">{String(i + 1).padStart(2, "0")}</span>
              <h3 class="mt-6 text-title">{s.title}</h3>
              <p class="mt-3 text-body text-muted">{s.text}</p>
            </li>
          ))}
        </ol>
      </Inner>
    </Band>
  ),
};

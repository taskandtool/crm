// How we'll do it: the work in four steps, each with when it happens. From public/services.md
// (how the business works), in its own words.
import { Band, Heading, Inner } from "./kit";
import type { ProposalComponent } from "./types";

const STEPS = [
  { when: "Before you sign", title: "We look first", text: "Sample words: what happens at the first visit, before the price is final." },
  { when: "A week before", title: "You approve the plan", text: "When the work is booked, and what they need to do before it." },
  { when: "On the day", title: "We do the work", text: "On the day we said, with the site kept clean and you told of anything we find." },
  { when: "When it is done", title: "We walk you through it", text: "A walkthrough at the end, and the warranty registered in your name." },
];

export const approach: ProposalComponent = {
  key: "approach", label: "How we'll do it", shows: "The work in four steps, with when each happens", on: true, sample: true,
  render: (d) => (
    <Band id="approach" tone={d.ground("approach")}>
      <Inner>
        <Heading title="How we'll do it" />
        <ol class="mt-16 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <li class="border-t-2 border-accent pt-6">
              <p class="text-small font-semibold text-accent">{s.when}</p>
              <h3 class="mt-3 text-title">{s.title}</h3>
              <p class="mt-3 text-body text-muted">{s.text}</p>
            </li>
          ))}
        </ol>
      </Inner>
    </Band>
  ),
};

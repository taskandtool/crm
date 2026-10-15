// Questions customers ask, answered. From public/business.md and the FAQ on
// their website, in their words.
import { Band, Heading, Inner } from "./kit";
import type { ProposalComponent } from "./types";

const QUESTIONS = [
  { q: "Do I need to be there on the day?", a: "Sample words: the answers your website already gives, kept short." },
  { q: "What warranty comes with the work?", a: "What is covered, for how long, and by whom." },
  { q: "Can I pay in parts?", a: "How deposits and the balance work." },
  { q: "What if something comes up mid-job?", a: "How a change is agreed before any extra work." },
];

export const faq: ProposalComponent = {
  key: "faq", label: "Questions", shows: "Questions customers ask, answered", on: false, sample: true,
  render: (d) => (
    <Band id="faq" tone={d.ground("faq")}>
      <Inner>
        <div class="grid gap-12 md:grid-cols-12">
          <div class="md:col-span-4"><Heading title="Questions" /></div>
          <dl class="flex flex-col md:col-span-8">
            {QUESTIONS.map((x) => (
              <div class="border-b border-line-strong py-6 first:pt-0">
                <dt class="text-title">{x.q}</dt>
                <dd class="mt-3 text-body text-muted">{x.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Inner>
    </Band>
  ),
};

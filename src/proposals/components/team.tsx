// Who they will meet: portraits, names and roles. From public/team.md and
// the portraits in brand/images.md; only people the business names itself.
import { Band, Heading, Inner, Picture, photo } from "./kit";
import type { ProposalComponent } from "./types";

const PEOPLE = [
  { name: "Team member", role: "Owner", line: "Sample words: one line about them, from your website.", photo: photo("") },
  { name: "Team member", role: "Lead technician", line: "Their experience, in a sentence.", photo: photo("") },
  { name: "Team member", role: "Customer care", line: "What they look after for you.", photo: photo("") },
];

export const team: ProposalComponent = {
  key: "team", label: "Our team", shows: "Portraits of the people who will do the work", on: true, sample: true,
  render: () => (
    <Band id="team">
      <Inner>
        <Heading eyebrow="Our team" title="The people you'll work with" />
        <ul class="mt-16 grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
          {PEOPLE.map((p) => (
            <li>
              <Picture src={p.photo} alt={p.name} label="A portrait, from your website" class="aspect-[4/5] w-full rounded-box" />
              <h3 class="mt-6 text-title">{p.name}</h3>
              <p class="mt-1 text-small text-accent">{p.role}</p>
              <p class="mt-3 text-body text-muted">{p.line}</p>
            </li>
          ))}
        </ul>
      </Inner>
    </Band>
  ),
};

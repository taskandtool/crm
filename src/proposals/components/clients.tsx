// Who else trusts them: a strip of client names or logos, and badges
// (licences, awards, memberships). From public/proof.md; logos from brand/images.md.
import { Band, Inner, photo } from "./kit";
import type { ProposalComponent } from "./types";

// A name, or a name with its logo (the logo a photo of brand/images/<file>).
const CLIENTS: { name: string; logo?: string | null }[] = [
  { name: "Client name" }, { name: "Client name" }, { name: "Client name" }, { name: "Client name" }, { name: "Client name" },
];

export const clients: ProposalComponent = {
  key: "clients", label: "Trusted by", shows: "A strip of client names or logos", on: false, sample: true,
  render: () => (
    <Band id="clients" tight>
      <Inner>
        <p class="text-center text-eyebrow uppercase text-muted">Trusted by</p>
        <ul class="mt-8 flex flex-wrap items-center justify-center gap-x-12 gap-y-6">
          {CLIENTS.map((c) => (
            <li>{c.logo ? <img src={c.logo} alt={c.name} class="h-9 w-auto object-contain opacity-80" /> : <span class="text-title text-muted">{c.name}</span>}</li>
          ))}
        </ul>
      </Inner>
    </Band>
  ),
};

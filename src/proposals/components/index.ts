// The proposal's components, in the order a page has them. A new one is a
// file beside these (its design and its words) and a line here; the team
// then finds it by its label on a quote's checklist. Cover and pricing are
// on every proposal, and the sign-off (page.tsx) closes every one.
import { about } from "./about";
import { approach } from "./approach";
import { clients } from "./clients";
import { cover } from "./cover";
import { faq } from "./faq";
import { gallery } from "./gallery";
import { intro } from "./intro";
import { pricing } from "./pricing";
import { reviews } from "./reviews";
import { team } from "./team";
import { terms } from "./terms";
import { work } from "./work";
import type { ProposalComponent } from "./types";

export const COMPONENTS: ProposalComponent[] = [cover, intro, about, approach, gallery, work, team, reviews, clients, pricing, faq, terms];

/** The ones a person picks; the rest are on every proposal. */
export const PICKABLE = COMPONENTS.filter((c) => !c.always);
export type { Ground, PageData, ProposalComponent, View } from "./types";

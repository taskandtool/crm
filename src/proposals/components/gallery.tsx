// A photograph edge to edge, between the words: the work, the place or the
// team. From brand/images.md.
import { Inner, Picture, photo } from "./kit";
import type { ProposalComponent } from "./types";

const PHOTO = photo("");
const CAPTION = "";

export const gallery: ProposalComponent = {
  key: "gallery", label: "A full photograph", shows: "One photograph across the whole page", on: false, sample: true,
  render: () => (
    <section id="gallery" class="bg-canvas print:break-before-page">
      <Picture src={PHOTO} alt={CAPTION} label="One wide photograph of the work" class="aspect-[16/7] min-h-80 w-full" />
      {CAPTION ? <Inner><p class="py-4 text-small text-muted">{CAPTION}</p></Inner> : null}
    </section>
  ),
};

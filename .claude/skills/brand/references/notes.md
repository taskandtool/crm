# The notes

## Layout

```
brand/
  positioning.md       what the business does, for whom, what makes it different; the name as it
                       should appear, the tagline, a one-paragraph description; contact and social links
  voice.md             the voice card and fingerprint (references/voice.md)
  audience.md          the actual people who buy, what they worry about, where they are when the
                       need shows up, what convinces them
  visual-identity.md   colours by role, type, logo, imagery (references/visual.md)
  do-and-dont.md       observable rules; words used and never used
  logo/                the logo files, svg preferred
  images/              a small curated set of the business's best photos; images.md describes each
  <anything>.md        further notes are welcome and read as context
public/
  business.md          type: business, one per business
  services.md          type: offering; or one note per offering when there are more than four
  locations.md         type: location; or one note per site, for a business with several
  faq.md               type: faq
  team.md              type: entity
  policies.md          type: policy (guarantees, cancellations, payment terms, service area)
  proof.md             type: proof
legal/                 terms, privacy, cookies, returns: copied verbatim, never rewritten
```

`brand/` is the look and the sound (each note `type: brand`); `public/` is anything the business would
say to a stranger. Internal knowledge (SOPs, pricing logic, people's
details) belongs in neither.

## A note

```markdown
---
title: Emergency hose repair
type: offering
updated: 2026-09-02
status: current
sources:
  - raw/site/example.com/pages/services.md
  - raw/transcripts/2026-08-30-chat.md
---

One paragraph that answers "what is this" for someone who has never heard of
it. Call-outs are $180 ([pricing](../raw/site/example.com/pages/pricing.md)).
```

Every note has `title`, `type`, `updated`, `status` and `sources`. A fact in
the body cites its raw file as a markdown link relative to the note, so it
opens wherever the notes are shown; frontmatter (`sources:`, `source:`) keeps
plain paths from the app root.

## Typed frontmatter

Apps read these fields as data (a website renders its footer, contact
section and JSON-LD from them), so the atomic facts live in frontmatter and
the prose lives in the body. Leave a field empty rather than guess.

```yaml
# public/business.md                    type: business
schema_type: LocalBusiness              # or the fitting schema.org subtype: Plumber, Dentist, Restaurant …
name: Harlow Joinery
legal_name: Harlow Joinery Ltd
telephone: "+44 117 496 0100"
email: hello@harlowjoinery.example
address: { street: "4 Mead Street", locality: Bristol, region: England, postal_code: "BS3 4RP", country: GB }
geo: { lat: 51.44, lng: -2.58 }
opening_hours: ["Mo-Fr 08:00-17:00", "Sa 09:00-12:00"]   # schema.org openingHours strings
time_zone: Europe/London            # the IANA zone the hours, bookings and reports are in
price_range: "££"
same_as: ["https://instagram.com/harlowjoinery"]          # the business's own profiles
area_served: "Bristol and Bath"

# public/locations.md (or one note per site)   type: location: the same fields, per location

# public/services.md (or one per offering)     type: offering
price: 180                              # a number, only when a source states one
currency: GBP
unit: per visit
area_served: ""

# public/faq.md                         type: faq: each question a `## ` heading, the answer beneath

# public/proof.md                       type: proof
reviews:
  - { quote: "…", name: "J. Okafor", role: "Clifton", platform: Google, date: 2026-03-02, stars: 5, source: raw/places/abc.json }
ratings:
  - { platform: Google, value: 4.9, count: 212, url: "https://maps.google.com/?cid=…", source: raw/places/abc.json }
logos:
  - { name: "Federation of Master Builders", file: /images/logos/fmb.png, source: raw/site/<host>/_index/media.json }
```

Legal pages go in `legal/<slug>.md` with `path` (the old URL) and `title`
frontmatter, the text verbatim.

## Sources in order of trust

For facts (name, phone, address, hours, prices): the site's own structured
data (`raw/site/<host>/structured/`), then the public listing in
`raw/places/`, then `_index/facts.json` (each fact with where it was found),
then page text, then documents. The owner's word in chat overrides all of
them, saved to `raw/transcripts/` first.

Contact facts come only from the business's own pages, header, footer and
listing, never from reviews, comments or blog posts, where other people's
numbers appear.

## Updating

- Change the note, bump `updated`, add the new source. The superseded line
  and conflicts: the SKILL.md's "Newer replaces older".

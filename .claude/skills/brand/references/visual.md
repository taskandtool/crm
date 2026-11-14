# The look

Write `brand/visual-identity.md` precisely enough for a website's design
tokens and marketing's image prompts. Read every value from real material
and cite it, or leave it to fill.

## Colours

Six-digit hex written as code (`#4e3223`), each with its role and where it is used today: the primary
(the one action colour), a dark, a light, a neutral for secondary text, and
any others. From a crawl, `raw/site/<host>/_index/styles.json` has the
computed colours by role. Check them against the screenshots in `shots/`:
a site's CSS often has colours that never appear on the page. With only a
logo or photos, sample their colours and cite them as the source.

For a text or link colour, write its contrast on its background (`#b05e27`
on white, 4.7:1). It needs at least 4.5:1. Use a lighter colour only as a
fill or an accent.

## Type

The display and body families, their weights, and where they load from
(Google Fonts, a file, a system font). `styles.json` names them for a crawled
site.

## Logo

Copy the files into `brand/logo/`, svg preferred, with a dark and a light
version when both exist. From a crawl, `_index/business-card.json` names
the logo. Show each in `visual-identity.md` (`![logo](logo/logo.svg)`). If there is no
usable file, say so; do not draw one.

## Photos and imagery

Copy a small set (about 10 to 30) of the business's best real photographs
from `raw/` into `brand/images/`. Pick for quality and
range: the work, the place, the people, the product; a gallery's photographs
are the work itself. Leave out stock, icons, theme art, anything blurry or
tiny, and any with a logo, words or a frame laid on it (a video's thumbnail
often has). From a crawl,
`_index/business-card.json` lists the photographs widest first, with their
sizes. `tt-crawl sheet --from raw/site/<host>` shows them numbered on one
sheet; describe each from that one look.

`brand/images.md` has one line per file: the picture itself
(`![what it shows](images/<file>)`, relative to the note), what it shows, who is in it, the
focal point, and whether the owner (and the customer, when it is their home
or face) agreed it may be used in advertising. Ask for the permissions in
one message.

The **Imagery** block in `visual-identity.md` describes the photography
for anyone briefing new images in the same style. Look at the photos
themselves, not their file names:

- what the photos show, and the settings they are taken in
- the light (time of day, hard or soft, warm or cool)
- the materials and textures, and the object that carries the brand's colour
- the people rule (who appears, how, or never)
- what never appears
- a one-paragraph style anchor that sums it up

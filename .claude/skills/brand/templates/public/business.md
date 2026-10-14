---
title: The business
type: business
updated: to fill
status: current
schema_type: LocalBusiness      # or a subtype: Plumber, Dentist, Restaurant, LegalService …
name: to fill
legal_name: ""
telephone: ""
email: ""
address: { street: "", locality: "", region: "", postal_code: "", country: "" }
geo: { lat: null, lng: null }
opening_hours: []               # ["Mo-Fr 08:00-17:00", "Sa 09:00-12:00"]
notice: ""                      # a closure or announcement, shown across the top of every page
notice_until: ""                # YYYY-MM-DD, the last day it shows
time_zone: ""                   # the IANA zone the hours are in, e.g. America/New_York
price_range: ""
same_as: []                     # social profile URLs
area_served: ""
sources: []
---

What the business is, in a paragraph, with the source of each fact inline.
Apps read the frontmatter above as data: a website renders its footer,
contact page and LocalBusiness JSON-LD from it. Lines marked "to fill" are
placeholders.

# Shaping the CRM, and importing a list

Read when shaping the CRM for a business, or importing or exporting customers.

## Shaping the CRM for a business

Read `crm.config.json`, the closest of `examples/` (a two-van HVAC shop, a
dental practice, a restaurant with events, a plumber with three locations
and eight trucks, a counselor who mostly wants a record), and what the
project already knows: the owner's words, a Company Brain's notes, the
Website's forms (`node scripts/forms.mjs list`). Ask only what you cannot
infer. Then:

1. Write the config (every key in `references/levers.md`), the business line included.
2. The defaults are already rows, so make the live statuses and deal
   stages match with `node scripts/stages.mjs` (`--statuses` for a
   customer's; rename, add, kind, archive with `--move-to`). Rename in
   place rather than archive and re-add: the key stays (`new` labelled
   `Enquiry`), and every script takes the label too.
3. The proposals, from the business's own website (ask for it when no note
   names it): `node scripts/proposal-read.mjs <url>` and the `brand` skill
   fill the brand record, then write each component from it and set its font
   (`references/money.md`, "A component is its file"). With no website,
   the samples stay and Send says so.
4. `npm run check`, then show the owner Home, a lead, a contact, the deals
   board and a quote's Preview.

A status says who someone is (Lead, Customer); a deal stage says where one
piece of work is (Estimate sent). A trade's per-job steps are deal stages,
so a returning customer gets a new deal rather than going backwards.

A location or an insurer is a custom field; the truck that went or a
party size is an event field; a technician, dentist or hygienist is on the
Team, and takes events. Name, email, phone,
company, address, source, tags and owner are built in and always show;
the config cannot hide them (hiding one is a small edit in
`src/views/`, done only when asked). A practice that keeps clinical or
therapy notes elsewhere keeps them out of this CRM, which is a contact
record; say so when shaping one.

## Import and export

**Import:** a CSV or an .xlsx (its first sheet). Always `--dry-run` first
and show the owner the mapping and the counts, then run it.

```bash
node scripts/import.mjs ~/app/uploads/customers.csv --dry-run
node scripts/import.mjs ~/app/uploads/customers.csv --map name=Client,phone="Cell #" --source "Old spreadsheet"
```

Headers match built-in names and custom fields, not `owner_label`: a
`Hygienist` column needs `--map owner=Hygienist`. Imported people are
created at the moment of the import, so give the file a `--source` (or
`--tag`) that a "new customers" count can leave out.

How rows match and what a match gains: `node scripts/import.mjs --help`.
`node scripts/export.mjs --out customers.csv` is the reverse, and its
headers import back as they are.

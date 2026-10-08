# Shaping the CRM, and importing a list

Read when shaping the CRM for a business, or importing or exporting customers.

## Shaping the CRM for a business

Read `crm.config.json`, the closest of `examples/` (a two-van HVAC shop, a
dental practice, a restaurant with events, a plumber with three locations
and eight trucks, a counselor who mostly wants a record), and what the
project already knows: the owner's words, a Company Brain's notes, the
Website's forms (`select key, title from forms`). Ask only what you cannot
infer. Then:

1. Write the config: words, statuses, deals (their name, stages and lost
   reasons), sources, fields, owner label, time zone, inbox, visits (their
   name and fields, or `false`), the business line.
2. Make the live statuses and deal stages match with `scripts/stages.mjs`
   (`--statuses` for a customer's; rename, add, set kind, archive with
   `--move-to`), since the defaults are already rows. Rename in place
   rather than archive and re-add: the key stays (`new` labelled
   `Enquiry`), which is fine, since nobody sees a key and every script
   takes the label too.
3. `python3 ~/tools/taskandtool.py restart`, `npm run check`, then show the owner
   What came in, a customer and the deals board.

A status says who someone is (Lead, Customer); a deal stage says where one
piece of work is (Estimate sent). A trade's per-job steps are deal stages,
so a returning customer gets a new deal rather than going backwards.

A location or an insurer is a custom field; the truck that went or a
party size is a visit field; a technician, dentist or hygienist is the
owner. Name, email, phone,
company, address, source, tags and owner are built in and always show;
the config cannot hide them (hiding one is a small edit in
`src/views/`, done only when asked). A practice that keeps clinical or
therapy notes elsewhere keeps them out of this CRM: it is a contact
record, and say so when shaping one.

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

Rows match existing customers and each other by email, then phone (a
row with neither matches by name a customer with neither). A match only
gains (empty fields filled, tags added); `--overwrite` replaces
values, status included. Anyone left without a last contact gets the
time of their latest submission, booking or payment, by email. The import
is one transaction. `node
scripts/export.mjs --out customers.csv` is the reverse, and its headers
import back as they are.

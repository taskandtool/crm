# Daily numbers from other systems

For an app with `scripts/reports.mjs` (the CRM, Lander). The lead report reads our Postgres only. Numbers that live elsewhere come in
through a scheduled job you write for this client, using their connection.
Never read those systems from a page.

| Number | Save it with | Report |
|---|---|---|
| Ad cost, clicks, impressions per day and ad | `node scripts/reports.mjs spend --file rows.json` | Ad cost, Cost per lead |
| A lead's status in their CRM, its sale | `node scripts/reports.mjs outcome <id> --status sold --sold 1200` | Appointments set, No-shows, Sold, Revenue |

Set a job up like this:

1. Ask the connection for its docs, and read a few real rows first. Field
   names vary by account, so match them to our words: `appointment_set`,
   `showed`, `no_show`, `sold`, `lost`. Each lead has one: someone who had the
   appointment and didn't buy stays `showed`; `lost` never got that far.
2. Read only. Yesterday and the last few days, since platforms revise them.
3. Tags must match. A lead's `utm_content` is the ad's name in Meta when the
   ad's URL parameters are
   `utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}`.
   Save spend under the same names; both are normalized the same way.
4. To match leads, save the other CRM's id with `--external-id` the first time,
   then name the lead as `ext:<id>`. Saving again replaces, so a re-run is safe.

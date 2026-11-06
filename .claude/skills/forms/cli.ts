// Forms from chat: list them, read one, make or change one from its JSON
// definition (checked as the editor checks it), and see what came in, with
// the booking and payment each led to. The same command in every app that
// carries this skill; an app's scripts/forms.mjs passes its settings. Machine only.
//
//   await formsCli(process.argv.slice(2), { withDb, source: "website", timeZone: "America/Denver" });
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { done, fail, flag, has, limitOf, localTime, machineEnv, misused, noMore, out, parseArgs, usage } from "../data/cli.mjs";
import type { Db } from "../data/db";
import { checkFields, FORM_KEY, sitePath, stepsOf, type Field } from "./fields";
import { linkedTo } from "./linked";
import { priceOf } from "./price";
import { formatMoney } from "../payments/money";
import { percentText, taxRates } from "../payments/tax";
import { bodyFor, checkDestination, destinationsOf, leadFields, missingFields, testSend } from "./destinations";
import { BOOKING_PAGE, loadForm } from "./store";

export type FormsCli = {
  withDb: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
  /** This app's slug, stored on a form it makes. */
  source: string;
  timeZone: string;
};

const HELP = `forms.mjs <command> [...] [--json]      the project's forms and what came in

  list                                 every form: its key, title, steps, and how many came in
  show <key>                           one form's definition, as JSON to edit
  save <key> --file <form.json>        make the form, or change it; the file holds
                                       { "title", "fields": [...], "success_message"?, "submit_label"?,
                                         "redirect_to"?, "notify_emails"?: [], "active"?, "leads"?, "deals"?, "owner"?, "deal_stage"?, "follow_up"? };
                                       without "notify_emails", new submissions are emailed to the owner
                                       "leads": false for a newsletter or job form: no lead per submission;
                                       "deals": true for each lead to become a deal straight away (an app with deals, the CRM),
                                       in "deal_stage" (a stage key; the first open one when left out); "owner": whose
                                       each lead and deal is, a team member's name or email; "follow_up": true for the
                                       phone skill's automatic thank-you or stopped-before-booking texts (by email without texting)
  submissions [--form <key>] [--limit 20]
                                       newest first, each with what was bought, its booking and payment,
                                       "not complete" while a booking or payment step is still to do,
                                       and who the team email reached
  unfinished [--form <key>]            forms with steps someone stopped in before their questions were done;
                                       stopped at a booking or payment is "not complete" under submissions
  destinations                         where leads go besides this database, how each has gone, and its last failure
  destination-save <key> --file <d.json>
                                       make one, or change it; the file holds { "title", "kind", "target", "path"?,
                                       "template"?, "forms"?, "send_when"?, "needs"?, "active"? }. "kind" webhook: "target"
                                       is the secret holding its address; connection: "target" is its slug and "path" the
                                       vendor's path; email: "target" is the addresses, and a secret or connection is the
                                       app's that takes the form. "template" shapes the body with {{field}}, or every field
                                       goes, flat: any answer's name, first_name last_name name email phone id form form_title
                                       page received_at text_consent utm_source utm_medium utm_campaign utm_term utm_content
                                       first_utm_* fbclid gclid msclkid ttclid referrer landing_page appointment_start
                                       appointment_end appointment_service appointment_with appointment_location.
                                       "send_when": answered (the default: the questions are done) or complete (the last step
                                       is). "needs": fields that must be present. "forms": form keys, "book" for the booking
                                       page; left out, every form that makes leads
  destination-test <key> [--submission <id>] [--confirm]
                                       what a lead would send, from that submission or the newest; --confirm really sends
                                       it, each time it is run, and keeps no record

A field is { "name", "label", "type", "required"? }; types: text, email, tel, textarea, select,
checkbox, radio (with "options"; "cards": true for big answer cards, "option_images": { option: url } for a picture on each; one card question on a step moves on at a click), date, number, consent, photo, items (with "currency" and "items":
[{ "key", "label", "price_cents", "unit"?, "image"?, "max"? }]), page (starts a new step),
booking (with "booking_type": a booking type's slug), payment (last; "currency"?, "fees"?: [{ "label",
"price_cents", "when"?: { "field", "is" } }], "tax_rate_id"?). Name fields name, email and phone
so the CRM finds the person.

Prints what happened first, then Next: (show prints the JSON alone). Errors go to stderr with a
Try: line; exit 1 when refused, 2 when misused.`;

export async function formsCli(argv: string[], cli: FormsCli): Promise<void> {
  const a = parseArgs(argv);
  const [cmd, ...rest] = a._;
  usage(a, cmd, ["list", "show", "save", "submissions", "unfinished", "destinations", "destination-save", "destination-test"], HELP, "forms",
    { list: [], show: [], save: ["file"], submissions: ["form", "limit"], unfinished: ["form"], destinations: [], "destination-save": ["file"], "destination-test": ["submission", "confirm"] });
  const at = `forms ${cmd}`;
  const json = has(a, "json");
  const keyOr = (k: string | undefined) =>
    k && FORM_KEY.test(k) ? k : cmd.startsWith("destination") ? misused(`${at}: name a destination by its key, like i360`, "node scripts/forms.mjs destinations") : misused(`${at}: name a form by its key, like contact`, "node scripts/forms.mjs list");
  // Everything the command was given is checked before the database is opened.
  const named = ["show", "save", "destination-save", "destination-test"].includes(cmd);
  noMore(rest, named ? 1 : 0, at);
  const key = named ? keyOr(rest[0]) : "";
  const file = cmd === "save" ? flag(a, "file") ?? misused("forms save: it needs --file <form.json>", `node scripts/forms.mjs show ${key} > form.json, edit it, then save ${key} --file form.json`)
    : cmd === "destination-save" ? flag(a, "file") ?? misused("forms destination-save: it needs --file <destination.json>", "node scripts/forms.mjs --help, for what the file holds") : "";
  const submission = cmd === "destination-test" && has(a, "submission") ? flag(a, "submission") ?? "" : null;
  if (submission !== null && !/^\d{1,18}$/.test(submission)) misused(`${at}: --submission is a submission's number`, "node scripts/forms.mjs submissions");
  const only = has(a, "form") ? keyOr(flag(a, "form")) : null;
  const limit = limitOf(a, at, { fallback: 20, max: 200 });
  /** A --form that names no form is wrong input, never "nothing came in". */
  const known = async (db: Db) => {
    if (only && !(await db.sql`select 1 from forms where key = ${only}`).length) fail(`${at}: no form ${only}`, "node scripts/forms.mjs list");
  };
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

  await cli.withDb(async (db) => {
    switch (cmd) {
      case "list": {
        const rows = await db.sql<{ key: string; title: string; active: boolean; fields: unknown; total: number }>`
          select f.key, f.title, f.active, f.fields,
                 (select count(*) from submissions s where s.form_key = f.key and s.status <> 'spam')::int as total
          from forms f order by f.title, f.key`;
        if (json) return out(true, rows, String);
        if (!rows.length) return done(at, "no forms yet", { next: "node scripts/forms.mjs save contact --file contact.json" });
        return done(at, plural(rows.length, "form"), {
          lines: rows.map((r) => {
            const steps = stepsOf(checkFields(r.fields).fields);
            const kinds = steps.filter((s) => s.kind !== "fields").map((s) => s.kind);
            return `${r.key}  ${r.title}  ${plural(steps.length, "step")}${kinds.length ? ` (${kinds.join(", ")})` : ""}  ${r.total} in${r.active ? "" : "  (off)"}`;
          }),
          next: "node scripts/forms.mjs submissions",
        });
      }

      case "show": {
        const [row] = await db.sql`select key, title, fields, notify_emails::text[] as notify_emails, redirect_to, success_message, submit_label, active, leads, deals, owner::text as owner, deal_stage, follow_up from forms where key = ${key}`;
        if (!row) fail(`forms show: no form ${key}`, "node scripts/forms.mjs list");
        return out(true, row, () => "");
      }

      case "save": {
        let def: Record<string, unknown>;
        try {
          def = JSON.parse(readFileSync(resolve(process.env.CALLER_CWD ?? ".", file), "utf8"));
        } catch (e) {
          return fail(`forms save: ${file} is not readable JSON (${(e as Error).message})`, `node scripts/forms.mjs show ${key}, for one to start from`);
        }
        const title = typeof def.title === "string" ? def.title.trim() : "";
        if (!title) fail(`forms save: ${file} has no "title"`, `{ "title": "Cookie order", "fields": [...] } in ${file}`);
        const { fields, problems } = checkFields(def.fields);
        if (Object.keys(problems).length) {
          const raw = Array.isArray(def.fields) ? def.fields : [];
          fail(`forms save: ${key} not saved; fix these in ${file}\n` + Object.entries(problems).map(([i, why]) => `  field ${Number(i) + 1} (${(raw[Number(i)] as Field)?.name ?? "?"}): ${why}`).join("\n"),
            `node scripts/forms.mjs save ${key} --file ${file}, once fixed (--help lists the field types)`);
        }
        if (!fields.length) fail(`forms save: ${file} lists no fields`, "node scripts/forms.mjs --help, for the field types");
        // A tax rate is named by its id, and must be one the project has, switched on.
        const taxed = fields.find((f) => f.type === "payment" && f.tax_rate_id);
        if (taxed) {
          const rates = await taxRates(db, { activeOnly: true });
          if (!rates.some((r) => r.id === taxed.tax_rate_id))
            fail(`forms save: ${key} not saved; tax_rate_id ${taxed.tax_rate_id} is not a tax rate in use\n  ${rates.length ? `In use: ${rates.map((r) => `${r.id} (${r.name}, ${percentText(r.percent_bp)})`).join(", ")}` : "The project has no tax rates yet; the CRM adds them (its invoices skill)"}`,
              `node scripts/forms.mjs save ${key} --file ${file}, ${rates.length ? "with one of those ids or " : ""}without tax_rate_id`);
        }
        // Without a list, the owner hears of each submission: a form that tells nobody is one nobody reads.
        const owner = machineEnv().OWNER_EMAIL?.trim();
        const emails = Array.isArray(def.notify_emails)
          ? def.notify_emails.filter((e): e is string => typeof e === "string")
          : owner ? [owner] : [];
        const redirect = def.redirect_to === undefined || def.redirect_to === null ? null : sitePath(def.redirect_to);
        if (def.redirect_to && !redirect) fail(`forms save: "redirect_to" must be a path on this site, like /thank-you`, `"redirect_to": "/thank-you" in ${file}`);
        const str = (k: string) => (typeof def[k] === "string" && (def[k] as string).trim() ? (def[k] as string).trim() : null);
        // Only a real change is written, so saving the same file twice says so.
        const [r] = await db.sql<{ made: boolean }>`
          insert into forms (key, title, fields, notify_emails, redirect_to, success_message, submit_label, active, leads, deals, owner, deal_stage, follow_up, source)
          values (${key}, ${title}, ${JSON.stringify(fields)}::jsonb, ${emails}::citext[], ${redirect}, ${str("success_message")}, ${str("submit_label")},
                  ${def.active !== false}, ${def.leads !== false}, ${def.leads !== false && def.deals === true}, ${def.leads !== false ? str("owner") : null}, ${def.leads !== false && def.deals === true ? str("deal_stage") : null}, ${def.follow_up === true}, ${cli.source})
          on conflict (key) do update set title = excluded.title, fields = excluded.fields, notify_emails = excluded.notify_emails,
            redirect_to = excluded.redirect_to, success_message = excluded.success_message, submit_label = excluded.submit_label,
            active = excluded.active, leads = excluded.leads, deals = excluded.deals, owner = excluded.owner, deal_stage = excluded.deal_stage, follow_up = excluded.follow_up, updated_at = now()
          where (forms.title, forms.fields, forms.notify_emails, forms.redirect_to, forms.success_message, forms.submit_label, forms.active, forms.leads, forms.deals, forms.owner, forms.deal_stage, forms.follow_up)
            is distinct from (excluded.title, excluded.fields, excluded.notify_emails, excluded.redirect_to, excluded.success_message, excluded.submit_label, excluded.active, excluded.leads, excluded.deals, excluded.owner, excluded.deal_stage, excluded.follow_up)
          returning (xmax = 0) as made`;
        const steps = stepsOf(fields);
        const outcome = !r ? "unchanged" : r.made ? "made" : "changed";
        if (json) return out(true, { key, outcome, steps: steps.length }, String);
        return done(at, `${outcome} form ${key}, ${plural(fields.length, "field")}, ${plural(steps.length, "step")}`, {
          lines: r ? [] : ["the file matches the saved form; nothing was written"],
          next: `on the site that takes it, link /forms/${key}/start, or embedForm(c, db, "${key}") in a page`,
        });
      }

      case "submissions": {
        await known(db);
        const form = only;
        const rows = await db.sql<{ id: string; form_key: string; name: string | null; email: string | null; status: string; data: Record<string, unknown>; created_at: Date; completed_at: Date | null; notified: string | null }>`
          select id::text as id, form_key, name, email::text as email, status, data, created_at, completed_at, notified from submissions
          where status <> 'spam' and (${form}::text is null or form_key = ${form})
          order by created_at desc, id desc limit ${limit}`;
        const linked = await linkedTo(db, rows.map((r) => r.id));
        const forms = new Map<string, Awaited<ReturnType<typeof loadForm>>>();
        for (const k of new Set(rows.map((r) => r.form_key))) forms.set(k, await loadForm(db, k));
        const shaped = rows.map((r) => {
          const f = forms.get(r.form_key);
          let total: string | null = null;
          try {
            const p = f ? priceOf(f, r.data) : null;
            total = p ? formatMoney(p.subtotal_cents, p.currency) : null;
          } catch {
            total = null;
          }
          const l = linked.get(r.id)!;
          return { ...r, total, booking: l.booking, payment: l.payment?.label ?? null };
        });
        if (json) return out(true, shaped, String);
        if (!shaped.length) return done(at, `nothing has come in${form ? ` on ${form}` : ""}`);
        return done(at, `${plural(shaped.length, "submission")}${form ? ` on ${form}` : ""}, newest first`, {
          lines: [
            ...shaped.map((r) => [`#${r.id}`, localTime(r.created_at, cli.timeZone), r.form_key, `[${r.status}]`, r.name ? `${r.name} <${r.email ?? ""}>` : r.email ?? "",
                r.total ? `order ${r.total}` : "", r.booking ? `booked ${localTime(r.booking.starts_at, cli.timeZone)}${r.booking.status === "cancelled" ? " (cancelled)" : ""}` : "",
                r.payment ?? "", r.completed_at ? "" : "not complete", r.notified ?? ""].filter(Boolean).join("  ")),
            ...(shaped.length === limit && limit < 200 ? [`the newest ${limit}; --limit 200 for more`] : []),
          ],
        });
      }

      case "destinations": {
        const list = await destinationsOf(db);
        const counts = await db.sql<{ destination_id: string; status: string; n: number }>`
          select destination_id::text as destination_id, status, count(*)::int as n from lead_deliveries group by 1, 2`;
        const of = (id: string, status: string) => counts.find((r) => r.destination_id === id && r.status === status)?.n ?? 0;
        const latest = await db.sql<{ destination_id: string; error: string }>`
          select distinct on (destination_id) destination_id::text as destination_id, error from lead_deliveries
          where status = 'failed' and error is not null order by destination_id, updated_at desc`;
        const why = (id: string) => latest.find((r) => r.destination_id === id)?.error ?? null;
        if (json) return out(true, list.map((d) => ({ ...d, sent: of(d.id, "sent"), failed: of(d.id, "failed"), waiting: of(d.id, "waiting"), last_error: why(d.id) })), String);
        if (!list.length) return done(at, "leads stay in this database; no destinations", { next: "node scripts/forms.mjs --help, for destination-save" });
        return done(at, plural(list.length, "destination"), {
          lines: list.map((d) => `${d.key}  ${d.title}  ${d.kind} ${d.target}${d.path ?? ""}  when ${d.send_when}  ${d.forms.length ? d.forms.join(", ") : "every lead form"}${d.needs.length ? `  needs ${d.needs.join(", ")}` : ""}  ${of(d.id, "sent")} sent, ${of(d.id, "failed")} failed, ${of(d.id, "waiting")} waiting${d.active ? "" : "  (off)"}${why(d.id) ? `  last failure: ${why(d.id)}` : ""}`),
          next: "node scripts/forms.mjs destination-test <key>",
        });
      }

      case "destination-save": {
        let def: unknown;
        try {
          def = JSON.parse(readFileSync(resolve(process.env.CALLER_CWD ?? ".", file), "utf8"));
        } catch (e) {
          return fail(`forms destination-save: ${file} is not readable JSON (${(e as Error).message})`, "node scripts/forms.mjs --help, for what the file holds");
        }
        const checked = checkDestination(def);
        if (!checked.ok) return fail(`forms destination-save: ${key} not saved; fix these in ${file}\n` + checked.problems.map((p) => `  ${p}`).join("\n"), `node scripts/forms.mjs destination-save ${key} --file ${file}, once fixed`);
        const v = checked.value;
        const unknown = v.forms.length ? (await db.sql<{ key: string }>`select key from unnest(${v.forms}::text[]) as k(key) where key not in (select key from forms) and key <> ${BOOKING_PAGE.key}`).map((r) => r.key) : [];
        if (unknown.length) return fail(`forms destination-save: ${key} not saved; no form ${unknown.join(", ")}`, "node scripts/forms.mjs list");
        const [r] = await db.sql<{ made: boolean }>`
          insert into lead_destinations (key, title, kind, target, path, template, forms, send_when, needs, active, source)
          values (${key}, ${v.title}, ${v.kind}, ${v.target}, ${v.path}, ${v.template === null ? null : JSON.stringify(v.template)}::jsonb, ${v.forms}::text[], ${v.send_when}, ${v.needs}::text[], ${v.active}, ${cli.source})
          on conflict (key) do update set title = excluded.title, kind = excluded.kind, target = excluded.target, path = excluded.path, template = excluded.template,
            forms = excluded.forms, send_when = excluded.send_when, needs = excluded.needs, active = excluded.active, updated_at = now()
          where (lead_destinations.title, lead_destinations.kind, lead_destinations.target, lead_destinations.path, lead_destinations.template, lead_destinations.forms, lead_destinations.send_when, lead_destinations.needs, lead_destinations.active)
            is distinct from (excluded.title, excluded.kind, excluded.target, excluded.path, excluded.template, excluded.forms, excluded.send_when, excluded.needs, excluded.active)
          returning (xmax = 0) as made`;
        const outcome = !r ? "unchanged" : r.made ? "made" : "changed";
        if (json) return out(true, { key, outcome }, String);
        const lines = [
          ...(r ? [] : ["the file matches what is saved; nothing was written"]),
          ...(v.kind === "webhook" && !machineEnv()[v.target] ? [`the secret ${v.target} is not on this machine: python3 ~/tools/taskandtool.py request-secret ${v.target}`] : []),
        ];
        return done(at, `${outcome} ${key}: ${v.title}, ${v.kind}, when ${v.send_when}`, { lines, next: `node scripts/forms.mjs destination-test ${key}` });
      }

      case "destination-test": {
        const d = (await destinationsOf(db)).find((x) => x.key === key);
        if (!d) return fail(`forms destination-test: no destination ${key}`, "node scripts/forms.mjs destinations");
        const [row] = await db.sql<{ id: string }>`
          select s.id::text as id from submissions s left join forms f on f.key = s.form_key
          where s.status <> 'spam'
            and (${submission}::bigint is null or s.id = ${submission}::bigint)
            and (s.form_key = any(${d.forms}::text[]) or (${d.forms}::text[] = '{}' and coalesce(f.leads, true)))
          order by s.created_at desc, s.id desc limit 1`;
        if (!row) return fail(`forms destination-test: ${submission ? `submission ${submission} is not one this destination takes` : `nothing has come in that ${key} takes`}`, "node scripts/forms.mjs submissions");
        const fields = (await leadFields(db, row.id))!;
        const missing = missingFields(d.needs, fields);
        const body = bodyFor(d, fields);
        const missingLine = missing.length ? [`this lead is missing ${missing.join(", ")}, so a real one would wait or fail`] : [];
        if (!has(a, "confirm")) {
          if (json) return out(true, { key, submission: row.id, missing, body }, String);
          return done(at, `${d.title} would get this for submission ${row.id}`, {
            lines: [body.length > 2000 ? `${body.slice(0, 2000)}\n(the first 2000 of ${body.length} characters; --json for all of it)` : body, ...missingLine],
            waits: `node scripts/forms.mjs destination-test ${key} --submission ${row.id} --confirm`,
          });
        }
        const r = await testSend(machineEnv(), d, fields);
        if (json && r.ok) return out(true, { key, submission: row.id, ...r }, String);
        if (!r.ok) return fail(`forms destination-test: ${d.title} did not take it: ${r.error}${r.response ? `\n  ${r.response.slice(0, 500)}` : ""}`, `node scripts/forms.mjs destination-test ${key}, to read what it sends`);
        return done(at, `${d.title} took submission ${row.id}${r.status ? ` (${r.status})` : ""}`, { lines: [...(r.response ? [r.response.slice(0, 500)] : []), ...missingLine, "no record kept of this test: running it again sends again, and real leads each go once"] });
      }

      case "unfinished": {
        await known(db);
        const form = only;
        const rows = await db.sql<{ id: string; form_key: string; name: string | null; email: string | null; step: number; updated_at: Date }>`
          select id::text as id, form_key, name, email::text as email, step, updated_at from submission_drafts
          where submission_id is null and not spam and (${form}::text is null or form_key = ${form})
          order by updated_at desc limit 100`;
        if (json) return out(true, rows, String);
        if (!rows.length) return done(at, "nobody stopped part way");
        return done(at, `${rows.length === 1 ? "1 person" : `${rows.length} people`} started and did not finish${rows.length === 100 ? " (the newest 100)" : ""}`, {
          lines: rows.map((r) => `${r.form_key}  ${r.name ?? r.email ?? "not given yet"}  ${plural(r.step, "step")} done  last ${localTime(r.updated_at, cli.timeZone)}`),
        });
      }
    }
  });
}

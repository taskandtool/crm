// Forms from chat: list them, read one, make or change one from its JSON
// definition (checked as the editor checks it), and see what came in, with
// the booking and payment each led to. The same command in every app that
// carries this skill; an app's scripts/forms.mjs passes its settings. Machine only.
//
//   await formsCli(process.argv.slice(2), { withDb, source: "website", timeZone: "America/Denver" });
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { done, fail, flag, has, limitOf, localTime, misused, noMore, out, parseArgs, usage } from "../data/cli.mjs";
import type { Db } from "../data/db";
import { checkFields, FORM_KEY, sitePath, stepsOf, type Field } from "./fields";
import { linkedTo } from "./linked";
import { priceOf } from "./price";
import { formatMoney } from "../payments/money";
import { percentText, taxRates } from "../payments/tax";
import { loadForm } from "./store";

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
                                         "redirect_to"?, "notify_emails"?: [], "active"? }
  submissions [--form <key>] [--limit 20]
                                       newest first, each with what was bought, its booking and payment,
                                       and "not complete" while a booking or payment step is still to do
  unfinished [--form <key>]            forms with steps someone started and did not finish

A field is { "name", "label", "type", "required"? }; types: text, email, tel, textarea, select,
checkbox, radio (with "options"), date, number, consent, items (with "currency" and "items":
[{ "key", "label", "price_cents", "unit"?, "image"?, "max"? }]), page (starts a new step),
booking (with "booking_type": a booking type's slug), payment (last; "currency"?, "fees"?: [{ "label",
"price_cents", "when"?: { "field", "is" } }], "tax_rate_id"?). Name fields name, email and phone
so the CRM finds the person.

Prints what happened first, then Next: (show prints the JSON alone). Errors go to stderr with a
Try: line; exit 1 when refused, 2 when misused.`;

export async function formsCli(argv: string[], cli: FormsCli): Promise<void> {
  const a = parseArgs(argv);
  const [cmd, ...rest] = a._;
  usage(a, cmd, ["list", "show", "save", "submissions", "unfinished"], HELP, "forms",
    { list: [], show: [], save: ["file"], submissions: ["form", "limit"], unfinished: ["form"] });
  const at = `forms ${cmd}`;
  const json = has(a, "json");
  const keyOr = (k: string | undefined) => (k && FORM_KEY.test(k) ? k : misused(`${at}: name a form by its key, like contact`, "node scripts/forms.mjs list"));
  // Everything the command was given is checked before the database is opened.
  noMore(rest, cmd === "show" || cmd === "save" ? 1 : 0, at);
  const key = cmd === "show" || cmd === "save" ? keyOr(rest[0]) : "";
  const file = cmd === "save" ? flag(a, "file") ?? misused("forms save: it needs --file <form.json>", `node scripts/forms.mjs show ${key} > form.json, edit it, then save ${key} --file form.json`) : "";
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
        const [row] = await db.sql`select key, title, fields, notify_emails::text[] as notify_emails, redirect_to, success_message, submit_label, active from forms where key = ${key}`;
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
        const emails = Array.isArray(def.notify_emails) ? def.notify_emails.filter((e): e is string => typeof e === "string") : [];
        const redirect = def.redirect_to === undefined || def.redirect_to === null ? null : sitePath(def.redirect_to);
        if (def.redirect_to && !redirect) fail(`forms save: "redirect_to" must be a path on this site, like /thank-you`, `"redirect_to": "/thank-you" in ${file}`);
        const str = (k: string) => (typeof def[k] === "string" && (def[k] as string).trim() ? (def[k] as string).trim() : null);
        // Only a real change is written, so saving the same file twice says so.
        const [r] = await db.sql<{ made: boolean }>`
          insert into forms (key, title, fields, notify_emails, redirect_to, success_message, submit_label, active, source)
          values (${key}, ${title}, ${JSON.stringify(fields)}::jsonb, ${emails}::citext[], ${redirect}, ${str("success_message")}, ${str("submit_label")},
                  ${def.active !== false}, ${cli.source})
          on conflict (key) do update set title = excluded.title, fields = excluded.fields, notify_emails = excluded.notify_emails,
            redirect_to = excluded.redirect_to, success_message = excluded.success_message, submit_label = excluded.submit_label,
            active = excluded.active, updated_at = now()
          where (forms.title, forms.fields, forms.notify_emails, forms.redirect_to, forms.success_message, forms.submit_label, forms.active)
            is distinct from (excluded.title, excluded.fields, excluded.notify_emails, excluded.redirect_to, excluded.success_message, excluded.submit_label, excluded.active)
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
        const rows = await db.sql<{ id: string; form_key: string; name: string | null; email: string | null; status: string; data: Record<string, unknown>; created_at: Date; completed_at: Date | null }>`
          select id::text as id, form_key, name, email::text as email, status, data, created_at, completed_at from submissions
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
                r.payment ?? "", r.completed_at ? "" : "not complete"].filter(Boolean).join("  ")),
            ...(shaped.length === limit && limit < 200 ? [`the newest ${limit}; --limit 200 for more`] : []),
          ],
        });
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

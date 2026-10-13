// Fixed texts of this app spliced into a statement where it names them
// (`{select}`, `{from}`): never a value, which stays a parameter.
import { q, type Db, type Query, type Row } from "../data/db";

export function spliced(texts: Record<string, string>) {
  const fill = (strings: TemplateStringsArray) => {
    const out = strings.map((s) => s.replace(/\{(\w+)\}/g, (m, k: string) => texts[k] ?? m));
    return Object.assign(out, { raw: out }) as TemplateStringsArray;
  };
  return {
    sql: (db: Db) => <T extends Row = Row>(strings: TemplateStringsArray, ...values: unknown[]) => db.sql<T>(fill(strings), ...values),
    q: (strings: TemplateStringsArray, ...values: unknown[]): Query => q(fill(strings), ...values),
  };
}

/** A phone's match key, as phone.ts's phoneKey: its last ten digits, an extension left off. The customers_phone_match index is this over `phone`. POSIX classes: a backslash would be lost before SQL saw it. */
export const phoneKeyOf = (col: string) =>
  `right(regexp_replace(regexp_replace(${col}, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10)`;

/** Row `x` is customer `c` by email, one they gained in a merge too: the stronger match. */
export const byEmail = (x: string) => `(${x}.email is not null and (c.email = ${x}.email or c.other_emails @> array[lower(${x}.email::text)]))`;

/** Row `x` (a submission, a booking) is customer `c`: by email, else by phone where either has no email (phone.ts). */
export const isCustomer = (x: string) =>
  `(${byEmail(x)} or ((c.email is null or ${x}.email is null) and length(${phoneKeyOf(`coalesce(${x}.phone, '')`)}) >= 7 and ${phoneKeyOf("c.phone")} = ${phoneKeyOf(`${x}.phone`)}))`;

/** A booking `b` is an event of customer `c`: it names them, or it is an online booking that is theirs. One held for a form still being paid is no one's event yet. */
export const EVENT_OF = `(b.hold_until is null and (b.customer_id = c.id or (b.customer_id is null and ${isCustomer("b")})))`;

/** Customer `c` is in play (an open status or an open deal) with nothing planned: no open task, nothing coming up. */
export const NOTHING_PLANNED = `(exists (select 1 from pipeline_stages s where s.key = c.stage and s.kind = 'open')
       or exists (select 1 from deals d join deal_stages s on s.key = d.stage where d.customer_id = c.id and d.archived_at is null and s.kind = 'open'))
  and not exists (select 1 from follow_ups t where t.customer_id = c.id and t.done_at is null)
  and not exists (select 1 from bookings b where b.status = 'confirmed' and b.starts_at >= now() and ${EVENT_OF})`;

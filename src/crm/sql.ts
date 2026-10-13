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

/** A booking `b` is an event of customer `c`: it names them, or it is an online booking under one of their emails. */
export const EVENT_OF = `(b.customer_id = c.id or (b.customer_id is null and b.email is not null and (b.email = c.email or c.other_emails @> array[lower(b.email::text)])))`;

/** Customer `c` is in play (an open status or an open deal) with nothing planned: no open task, nothing coming up. */
export const NOTHING_PLANNED = `(exists (select 1 from pipeline_stages s where s.key = c.stage and s.kind = 'open')
       or exists (select 1 from deals d join deal_stages s on s.key = d.stage where d.customer_id = c.id and d.archived_at is null and s.kind = 'open'))
  and not exists (select 1 from follow_ups t where t.customer_id = c.id and t.done_at is null)
  and not exists (select 1 from bookings b where b.status = 'confirmed' and b.starts_at >= now() and ${EVENT_OF})`;

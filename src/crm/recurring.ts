// The CRM's side of recurring invoices (the invoices skill's recurring.ts):
// where their work shows up for a person. A task on the customer, for the
// recurring invoice's owner (else the customer's), due on the date it is
// for; a recurring invoice whose email matches no customer prints instead.
import type { Db } from "../data/db";
import type { Recurring, RunDeps } from "../invoices/recurring";
import { findMatch } from "./customers";
import { addTask } from "./tasks";

export function recurringTask(db: Db): NonNullable<RunDeps["task"]> {
  return async (r: Recurring, t) => {
    const customer = await findMatch(db, r.email, r.phone);
    if (!customer) return console.error(`recurring #${r.id}: ${t.title} (no customer with ${r.email} to put a task on)`);
    await addTask(db, customer.id, { kind: "task", title: t.title, due_on: t.due_on, due_time: null, owner: r.owner ?? customer.owner, deal_id: null }, "Recurring invoices");
  };
}

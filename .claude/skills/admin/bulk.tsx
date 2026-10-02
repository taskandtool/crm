// Bulk actions without JavaScript. The row checkboxes sit in the table, not
// inside this form: each names it with `form="<id>"` (TableSpec.select), so
// rows added later by "Load more" join the form too, and a row's own status
// form never nests inside it. The route reads the ids with
//   formIds((await c.req.parseBody({ all: true })).id)
// and answers with a 303 to `return` carrying a count for <Flash>.
import type { Child } from "hono/jsx";
import { buttonClass } from "./status";

export function BulkForm(props: {
  id: string;
  action: string;
  returnTo: string;
  /** The controls that say what to do, e.g. a status select with a label. */
  children?: Child;
  submit?: string;
}) {
  const { id, action, returnTo, children, submit = "Apply to selected" } = props;
  return (
    <form id={id} method="post" action={action} aria-label="Change selected rows" class="mb-3 flex flex-wrap items-end gap-3">
      <input type="hidden" name="return" value={returnTo} />
      {children}
      <button class={buttonClass}>{submit}</button>
    </form>
  );
}

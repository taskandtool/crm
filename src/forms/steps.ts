// What a booking step or a payment step must do inside a form. The forms
// skill walks a form's steps; the booking and payments skills each ship one
// adapter that implements this (booking/form-step.tsx, payments/form-step.ts),
// and the app hands them to formRoutes once:
//
//   formRoutes(getDb, { source, page, steps: { booking: bookingStep(…), payment: paymentStep(…) } })
//
// Forms never imports booking or payments; they import this file's types.
// A step runs after the questions, when the submission exists, so what it
// makes (a booking, a payment) names the submission.
import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { Errors, Field, Form, Input } from "./fields";
import type { Charge, Price } from "./price";

export type StepContext = {
  form: Form;
  /** The `booking` or `payment` field: its label, and its settings (booking_type). */
  field: Field;
  /** The submission the questions made. */
  submission: { id: string; name: string | null; email: string | null; phone: string | null; data: Record<string, unknown> };
  /** Where the step's form posts, and the hidden inputs it must carry (the visitor's key). */
  action: string;
  hidden: Child;
  /** Where to send them once this step is done: the next step, or the thanks page. Absolute. */
  next: string;
  /** What the submission costs so far (price.ts), or null for nothing. A payment step charges this. */
  price: Price | null;
  /** This step's own page, absolute: where to come back to (a cancelled checkout). */
  self: string;
};

/**
 * Done: carry on to `redirect` (Checkout, say) or the next step; `charge` adds
 * to what the submission costs (a booking's price). Not done: show the step
 * again with these errors.
 */
export type StepResult = { ok: true; redirect?: string; charge?: Charge } | { ok: false; errors: Errors };

export type FormStep = {
  /** The step's body, inside the app's page: a form posting to ctx.action with ctx.hidden in it. */
  render(c: Context, ctx: StepContext, shown: { errors?: Errors; values?: Input }): Child | Promise<Child>;
  /** Take what they sent. Never throws for a person's mistake: that is an error to show. */
  take(c: Context, ctx: StepContext, input: Input): Promise<StepResult>;
  /**
   * Whether what this step did still stands, checked before a later step
   * runs (a held time released while they waited). False sends them back to
   * this step, its charge removed.
   */
  stillValid?(c: Context, ctx: StepContext): Promise<boolean>;
};

export type FormSteps = Partial<Record<"booking" | "payment", FormStep>>;

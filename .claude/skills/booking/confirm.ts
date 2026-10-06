// A booking made inside a form is confirmed when the form is complete: its
// last step done in the visitor's request, or, for a form that ends in
// payment, Stripe's paid event. Never when the time is picked, so someone
// who walks away from paying is sent nothing. Edge-safe.
//
//   // the form's completion (forms routes' onComplete)
//   onComplete: (c, id) => afterResponse(c, confirmFormBooking(getDb(c), id, emailSender(envOf(c)), { domain, manageBase })),
//   // the payments webhook (afterPaid), in every app that mounts it
//   afterPaid: async (c, paymentId) => {
//     const id = await completePaidSubmission(getDb(c), paymentId);
//     if (id && (await confirmFormBooking(getDb(c), id, emailSender(envOf(c)), { domain, manageBase })).status === "failed") throw new Error("send failed");
//   },
//
// It ends the booking's hold first (hold_until), so the time is kept and
// reminders go, even in an app with no sender.
//
// Either app may run it, more than once: the booking is claimed in one
// statement (confirmation_sent_at), so one sends. An app with no sender
// (emailSender is null) never claims it, so it is left for the app that has
// one; a send that fails gives the claim back for a retry.
import type { Db } from "../data/db";
import type { Sent } from "../data/send";
import { newToken, tokenHash } from "../data/token";
import { resourceById, toBooking, typeById } from "./book";
import { notifyBooking, type Send } from "./notify";

export type ConfirmOptions = {
  /** The domain in the invite's UID: the same one every other invite of the app uses. */
  domain: string;
  /** The booking pages' address, absolute ("https://acme.com/book"), for the manage link; none says to reply instead. */
  manageBase?: string | null;
};

export async function confirmFormBooking(db: Db, submissionId: string, send: Send | null, opts: ConfirmOptions): Promise<Sent> {
  // The form is complete: its time is no longer held, sender or not.
  await db.sql`update bookings set hold_until = null, updated_at = now()
               where submission_id = ${submissionId}::bigint and status = 'confirmed' and hold_until is not null`;
  if (!send) return { status: "none", why: "no email sender in this app" };
  // The manage link is made now: the one made when the time was picked was never sent.
  const token = newToken();
  const [row] = await db.sql`
    update bookings set confirmation_sent_at = now(), manage_token_hash = ${await tokenHash(token)}, updated_at = now()
    where id = (select id from bookings
                where submission_id = ${submissionId}::bigint and status = 'confirmed' and confirmation_sent_at is null
                order by id limit 1 for update skip locked)
    returning *`;
  if (!row) return { status: "none", why: "no booking waiting for its confirmation" };
  const booking = toBooking(row);
  const [type, host] = await Promise.all([typeById(db, booking.type_id), resourceById(db, booking.resource_id)]);
  const manageUrl = opts.manageBase ? `${opts.manageBase.replace(/\/+$/, "")}/manage/${token}` : null;
  const sent: Sent =
    type && host
      ? await notifyBooking(send, { event: "booked", booking, type, host, manageUrl }, { domain: opts.domain })
      : { status: "none", why: "its type or host is gone" };
  if (sent.status !== "sent") await db.sql`update bookings set confirmation_sent_at = null where id = ${booking.id}::bigint`;
  return sent;
}

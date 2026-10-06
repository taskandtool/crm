// What a booker is told, and how it reaches them. The words live here once
// (bookingMessage); the delivery is a `Send`, a function that takes a
// message and says what happened. The default is email through the sender
// the owner connected (data/send.ts: NOTIFY_FROM, NOTIFY_VIA, a bound key at
// the edge or the gateway on the machine). No sender: nothing is sent, the
// booking stands, and the manage page's .ics download is the invite. Task &
// Tool never sends for an app.
//
//   onBooked: (c, e) => afterResponse(c, notifyBooking(emailSend(envOf(c)), e, { domain })),
//
// Another connector is another Send: a text through the owner's Twilio,
// written by the app's AI against the gateway, takes the same message and
// returns the same `Sent`. The reminder job (reminders-job.ts) takes one too.
import { setting, type Env } from "../data/env";
import { sendEmail, senderOf, type Sent } from "../data/send";
import { whereText, type Booking, type BookingType, type Resource } from "./book";
import { icsContentType, invite, type IcsMethod } from "./ics";
import { formatSlot, isValidZone } from "./slots";

export type Message = {
  to: string;
  subject: string;
  text: string;
  /** Replies go to the person taking it, so a booker can answer a reminder. */
  replyTo?: string | null;
  /** The calendar invite, for a sender that can attach one. */
  ics?: { text: string; method: IcsMethod } | null;
};

/** Delivers one message; never throws (a failure is a `failed` Sent). */
export type Send = (m: Message) => Promise<Sent>;

/** emailSend, or null when this app has no sender set up (no connection, or no NOTIFY_FROM): say so before claiming work only a sender can do. */
export function emailSender(env: Env, doFetch: typeof fetch = fetch): Send | null {
  return typeof senderOf(env) === "string" || !setting(env, "NOTIFY_FROM") ? null : emailSend(env, doFetch);
}

/** Email through the connected sender, the invite attached. */
export function emailSend(env: Env, doFetch: typeof fetch = fetch): Send {
  return (m) =>
    sendEmail(
      env,
      {
        to: [m.to],
        subject: m.subject,
        text: m.text,
        replyTo: m.replyTo,
        attachments: m.ics
          ? [{ filename: m.ics.method === "CANCEL" ? "cancel.ics" : "invite.ics", content: m.ics.text, contentType: icsContentType(m.ics.method) }]
          : undefined,
      },
      doFetch,
    );
}

export type MessageKind = "booked" | "rescheduled" | "cancelled" | "reminder";

export type About = {
  booking: Pick<Booking, "name" | "email" | "starts_at" | "ends_at" | "location_kind" | "location" | "booker_time_zone">;
  type: Pick<BookingType, "name">;
  host: Pick<Resource, "name" | "time_zone">;
  /** The manage link: only where the booker was just given it (it is never stored). */
  manageUrl?: string | null;
};

/** The words for a booker: what, with whom, when in their own zone, where, and how to change it. */
export function bookingMessage(kind: MessageKind, a: About): { subject: string; text: string } {
  const b = a.booking;
  const zone = b.booker_time_zone && isValidZone(b.booker_time_zone) ? b.booker_time_zone : a.host.time_zone;
  const when = formatSlot({ start: b.starts_at, end: b.ends_at }, zone);
  const what = `${a.type.name} with ${a.host.name}`;
  const where = kind === "cancelled" ? null : whereText(b, { link: true });
  // A reminder never has the link (only its hash is stored); a booking the
  // team made for someone may have none (no public booking page here).
  const change = a.manageUrl
    ? `To change or cancel: ${a.manageUrl}`
    : kind === "reminder"
      ? "To change or cancel, use the link in your booking confirmation, or reply to this email."
      : "To change or cancel, reply to this email.";
  const lines = (first: string, last: string | null) => [`Hi ${b.name},`, "", first, "", when, ...(where ? [where] : []), ...(last ? ["", last] : [])].join("\n");
  switch (kind) {
    case "booked":
      return { subject: `Booked: ${a.type.name}`, text: lines(`You are booked: ${what}.`, change) };
    case "rescheduled":
      return { subject: `Moved: ${a.type.name}`, text: lines(`Your ${what} has moved to a new time.`, change) };
    case "cancelled":
      return { subject: `Cancelled: ${a.type.name}`, text: lines(`Your ${what} is cancelled.`, null) };
    case "reminder":
      return { subject: `Reminder: ${a.type.name}`, text: lines(`A reminder of your ${what}.`, change) };
  }
}

/**
 * A booking made, moved or cancelled, as every booking page reports it to its
 * onBooked: the public pages, the team's, and a form's booking step.
 * manageUrl is the booker's own link to change or cancel, when there is one.
 */
export type BookingNotice = {
  event: "booked" | "rescheduled" | "cancelled";
  booking: Booking;
  type: BookingType;
  host: Resource;
  manageUrl: string | null;
};

/**
 * Tell the booker about a booking, a move or a cancel, with the calendar
 * invite (REQUEST, or CANCEL with a higher SEQUENCE) when the host has an
 * email to organize it from.
 */
export function notifyBooking(
  send: Send,
  e: BookingNotice,
  opts: { domain: string },
): Promise<Sent> {
  const { subject, text } = bookingMessage(e.event, e);
  const method: IcsMethod = e.event === "cancelled" ? "CANCEL" : "REQUEST";
  const ics = e.host.email
    ? {
        method,
        text: invite({
          method, booking: e.booking, domain: opts.domain, organizer: { email: e.host.email, name: e.host.name },
          summary: `${e.type.name} with ${e.host.name}`, location: e.booking.location, url: e.manageUrl,
        }),
      }
    : null;
  return send({ to: e.booking.email, subject, text, replyTo: e.host.email, ics });
}

/** Your own words with the invite attached, for a message bookingMessage does not cover. */
export function sendInvite(
  env: Env,
  mail: { to: string; subject: string; text: string; ics: string; method: IcsMethod },
  doFetch: typeof fetch = fetch,
): Promise<Sent> {
  return emailSend(env, doFetch)({ to: mail.to, subject: mail.subject, text: mail.text, ics: { text: mail.ics, method: mail.method } });
}

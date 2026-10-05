// The confirmation email with the invite attached, through the sender the
// owner connected (data/send.ts: NOTIFY_FROM, NOTIFY_VIA, a bound key
// at the edge or the gateway on the machine). No sender: nothing is sent,
// and the manage page's .ics download is the invite.
//
//   onBooked: (c, e) => afterResponse(c, sendInvite(envOf(c), {
//     to: e.booking.email, subject: `Booked: ${e.type.name} with ${e.host.name}`, text: `Change or cancel: ${e.manageUrl}`,
//     ics: invite({ method: "REQUEST", booking: e.booking, domain, organizer: { email: e.host.email!, name: e.host.name },
//       summary: inviteSummary(e.type, e.host), location: e.booking.location, url: e.manageUrl }), method: "REQUEST",
//   })),
import type { Env } from "../data/env";
import { sendEmail, type Sent } from "../data/send";
import { icsContentType, type IcsMethod } from "./ics";

export function sendInvite(
  env: Env,
  mail: { to: string; subject: string; text: string; ics: string; method: IcsMethod },
  doFetch: typeof fetch = fetch,
): Promise<Sent> {
  const filename = mail.method === "CANCEL" ? "cancel.ics" : "invite.ics";
  return sendEmail(
    env,
    { to: [mail.to], subject: mail.subject, text: mail.text, attachments: [{ filename, content: mail.ics, contentType: icsContentType(mail.method) }] },
    doFetch,
  );
}

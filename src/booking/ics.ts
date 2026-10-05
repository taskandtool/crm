// An iCalendar (RFC 5545) invite for one booking. Edge-safe.
//
//   const text = invite({ method: "REQUEST", booking, domain: "acme.com", organizer, summary: "Intro call with Acme" });
//   new Response(text, { headers: { "Content-Type": icsContentType("REQUEST") } })
//
// What clients rely on, and what goes quietly wrong without it:
// - UID is stable for the booking (booking id @ the business's domain), so a
//   reschedule updates the event and a cancel removes it instead of adding a
//   second one.
// - SEQUENCE is bookings.sequence, which rises on every reschedule and
//   cancel. A client ignores an update whose SEQUENCE is not higher.
// - REQUEST is an invitation sent by email; CANCEL removes it (same UID,
//   higher SEQUENCE, STATUS:CANCELLED). A file offered for download is
//   PUBLISH: some clients treat a downloaded REQUEST as an invitation the
//   importer must answer. A PUBLISH has no ATTENDEE (RFC 5546 3.2.1), or
//   Outlook opens the download as a meeting.
// - Times are UTC (…Z): no VTIMEZONE block to get wrong.
// - Text escapes backslash, semicolon, comma and newlines; lines fold at 75
//   octets (bytes, not characters) without splitting a UTF-8 character; every
//   line ends CRLF.

export type IcsMethod = "REQUEST" | "CANCEL" | "PUBLISH";
export type Party = { email: string; name?: string | null };

export type InviteInput = {
  method: IcsMethod;
  booking: { id: string; starts_at: Date; ends_at: Date; sequence: number; name: string; email: string };
  /** The business's domain, for the UID: booking-<id>@<domain>. Keep it fixed for the life of the app. */
  domain: string;
  /** Required for REQUEST and CANCEL; a PUBLISH download may leave it out. */
  organizer?: Party | null;
  summary: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  /** DTSTAMP; defaults to now. */
  now?: Date;
};

export const icsContentType = (method: IcsMethod) => `text/calendar; charset=utf-8; method=${method}`;

/** A TEXT value: backslash, semicolon, comma and newlines escaped; other control characters (not allowed in TEXT) dropped. */
export function escapeText(s: string): string {
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** A parameter value (CN=…): quoted; a quote or control character cannot appear in one, so they are dropped. */
function paramValue(s: string): string {
  return `"${s.replace(/["\x00-\x1f\x7f]/g, "")}"`;
}

/** 20260309T100000Z */
export function icsTime(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

const enc = new TextEncoder();

/** Fold one content line at 75 octets; continuation lines start with a space (which counts). */
export function fold(line: string): string {
  const out: string[] = [];
  let cur = "", bytes = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = " ";
      bytes = 1;
      limit = 75;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

const mailto = (email: string) => "mailto:" + email.replace(/[\r\n]/g, "");

export function invite(input: InviteInput): string {
  const { method, booking: b, organizer } = input;
  const cancel = method === "CANCEL";
  if (!organizer?.email && method !== "PUBLISH") throw new Error(`METHOD:${method} needs an organizer`);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Task & Tool//booking 0.2.0//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:booking-${b.id}@${input.domain.replace(/[^\w.-]/g, "")}`,
    `SEQUENCE:${b.sequence}`,
    `DTSTAMP:${icsTime(input.now ?? new Date())}`,
    `DTSTART:${icsTime(b.starts_at)}`,
    `DTEND:${icsTime(b.ends_at)}`,
    `SUMMARY:${escapeText(input.summary)}`,
    ...(input.description ? [`DESCRIPTION:${escapeText(input.description)}`] : []),
    ...(input.location ? [`LOCATION:${escapeText(input.location)}`] : []),
    ...(input.url ? [`URL:${input.url.replace(/[\r\n]/g, "")}`] : []),
    ...(organizer?.email ? [`ORGANIZER${organizer.name ? `;CN=${paramValue(organizer.name)}` : ""}:${mailto(organizer.email)}`] : []),
    ...(method === "PUBLISH" ? [] : [`ATTENDEE;CN=${paramValue(b.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:${mailto(b.email)}`]),
    `STATUS:${cancel ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

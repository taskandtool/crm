import { test } from "node:test";
import assert from "node:assert/strict";
import { bookingMessage, notifyBooking, sendInvite, type Message, type Send } from "../notify";

const mail = { to: "ann@example.com", subject: "Booked", text: "See you", ics: "BEGIN:VCALENDAR\r\nSUMMARY:Café\r\nEND:VCALENDAR\r\n", method: "REQUEST" as const };

function capture() {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, f };
}

test("no NOTIFY_FROM or no sender: nothing is sent", async () => {
  const { calls, f } = capture();
  assert.equal((await sendInvite({ RESEND_API_KEY: "re_1" }, mail, f)).status, "none");
  assert.equal((await sendInvite({ NOTIFY_FROM: "hi@acme.com" }, mail, f)).status, "none");
  assert.equal(calls.length, 0);
});

test("the invite goes as an attachment with the method in its content type", async () => {
  const { calls, f } = capture();
  assert.deepEqual(await sendInvite({ RESEND_API_KEY: "re_1", NOTIFY_FROM: "hi@acme.com" }, mail, f), { status: "sent", via: "resend" });
  const a = calls[0].body.attachments[0];
  assert.equal(a.filename, "invite.ics");
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0))), mail.ics);
  assert.equal(a.content_type, "text/calendar; charset=utf-8; method=REQUEST");
  assert.deepEqual(calls[0].body.to, ["ann@example.com"]);
});

test("a cancel through the gateway on the machine is cancel.ics with the machine token", async () => {
  const { calls, f } = capture();
  const env = { NOTIFY_VIA: "postmark", PHOENIX_URL: "https://phx", MACHINE_TOKEN: "mt", NOTIFY_FROM: "hi@acme.com" };
  assert.deepEqual(await sendInvite(env, { ...mail, method: "CANCEL" }, f), { status: "sent", via: "gateway:postmark" });
  assert.equal(calls[0].url, "https://phx/api/sprite/gateway/postmark/email");
  assert.equal(calls[0].headers.get("authorization"), "Bearer mt");
  assert.equal(calls[0].body.Attachments[0].Name, "cancel.ics");
  assert.equal(calls[0].body.Attachments[0].ContentType, "text/calendar; charset=utf-8; method=CANCEL");
});

const about = {
  booking: {
    id: "7", name: "Ann", email: "ann@example.com", phone: null, starts_at: new Date("2026-03-10T15:00:00Z"), ends_at: new Date("2026-03-10T16:00:00Z"),
    location_kind: "their_place" as const, location: "12 Elm St", booker_time_zone: "America/Chicago", sequence: 0,
  },
  type: { name: "Estimate visit" },
  host: { name: "Pat", time_zone: "America/New_York", email: "pat@example.com" },
};

test("the words: what and who, when in the booker's zone, where, how to change it; a cancel has no place or link", () => {
  const booked = bookingMessage("booked", { ...about, manageUrl: "https://acme.example/book/manage/tok" });
  assert.equal(booked.subject, "Booked: Estimate visit");
  assert.equal(booked.text, "Hi Ann,\n\nYou are booked: Estimate visit with Pat.\n\nTuesday, March 10, 10:00 AM to 11:00 AM CDT\nAt 12 Elm St\n\nTo change or cancel: https://acme.example/book/manage/tok");
  const cancelled = bookingMessage("cancelled", about);
  assert.equal(cancelled.text, "Hi Ann,\n\nYour Estimate visit with Pat is cancelled.\n\nTuesday, March 10, 10:00 AM to 11:00 AM CDT");
  assert.doesNotMatch(bookingMessage("reminder", about).text, /—/, "no em dashes");
});

test("notifyBooking sends the confirmation with a REQUEST invite, and a cancel with a CANCEL, through any Send", async () => {
  const sent: Message[] = [];
  const send: Send = async (m) => (sent.push(m), { status: "sent", via: "test" });
  const e = { booking: { ...about.booking, type_id: "1", resource_id: "2", status: "confirmed", answers: {}, source: "website", external_event_id: null, cancelled_at: null, updated_by: null, created_at: new Date(), updated_at: new Date() }, type: { name: "Estimate visit" }, host: { id: "2", name: "Pat", email: "pat@example.com", time_zone: "America/New_York", active: true }, manageUrl: "https://acme.example/book/manage/tok" } as any;
  await notifyBooking(send, { ...e, event: "booked" }, { domain: "acme.example" });
  assert.equal(sent[0].replyTo, "pat@example.com");
  assert.equal(sent[0].ics?.method, "REQUEST");
  assert.match(sent[0].ics!.text, /SUMMARY:Estimate visit with Pat/);
  assert.match(sent[0].ics!.text, /LOCATION:12 Elm St/);
  await notifyBooking(send, { ...e, event: "cancelled", booking: { ...e.booking, status: "cancelled", sequence: 1 } }, { domain: "acme.example" });
  assert.equal(sent[1].ics?.method, "CANCEL");
  await notifyBooking(send, { ...e, event: "booked", host: { ...e.host, email: null } }, { domain: "acme.example" });
  assert.equal(sent[2].ics, null, "no organizer, no invite: the manage page's download is it");
});

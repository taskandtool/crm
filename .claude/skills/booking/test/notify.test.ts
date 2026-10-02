import { test } from "node:test";
import assert from "node:assert/strict";
import { sendInvite } from "../notify";

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

import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { envOf, envVar, keyName } from "../env";
import { gatewayFetch } from "../gateway";
import { sendEmail, senderOf } from "../send";

const msg = { to: ["owner@example.com"], subject: "New\r\nBcc: x", text: "Hi", replyTo: "ann@example.com" };

function recorder(status = 200) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { calls, f };
}

// ── env ──────────────────────────────────────────────────────────────────────

test("a Worker binding wins; under node-server's { incoming, outgoing } the process env is read", async () => {
  process.env.SEND_TEST_SETTING = "from-process";
  try {
    const app = new Hono();
    app.get("/", (c) => c.text(`${envVar(c, "SEND_TEST_SETTING")}|${envVar(c, "SEND_TEST_BOUND") ?? ""}`));
    // At the edge: bindings are c.env.
    assert.equal(await (await app.request("/", {}, { SEND_TEST_SETTING: "bound", SEND_TEST_BOUND: "yes" })).text(), "bound|yes");
    // On the machine: c.env is an object with no settings in it, so it must not shadow process.env.
    assert.equal(await (await app.request("/", {}, { incoming: {}, outgoing: {} })).text(), "from-process|");
    // A binding that is not text (a KV namespace, a service) is not a setting.
    assert.equal(await (await app.request("/", {}, { SEND_TEST_SETTING: { get() {} } })).text(), "from-process|");
  } finally {
    delete process.env.SEND_TEST_SETTING;
  }
});

test("envOf reads the request's settings by name, and keyName is the connection's env name", async () => {
  const app = new Hono();
  app.get("/", (c) => {
    const env = envOf(c);
    return c.text(typeof env === "function" ? env("RESEND_API_KEY") ?? "" : "");
  });
  assert.equal(await (await app.request("/", {}, { RESEND_API_KEY: "re_1" })).text(), "re_1");
  assert.equal(keyName("resend"), "RESEND_API_KEY");
  assert.equal(keyName("postmark-2"), "POSTMARK_2_API_KEY");
});

// ── gateway ──────────────────────────────────────────────────────────────────

test("the gateway call carries the machine token to the slug's path; off the machine it fails plainly", async () => {
  const r = recorder();
  await gatewayFetch({ PHOENIX_URL: "https://tt.example/", MACHINE_TOKEN: "mt" }, "google-calendar", "/calendar/v3/x", { method: "POST", body: "{}" }, r.f);
  assert.equal(r.calls[0].url, "https://tt.example/api/machine/gateway/google-calendar/calendar/v3/x");
  assert.equal(r.calls[0].headers.get("authorization"), "Bearer mt");
  assert.equal(r.calls[0].headers.get("content-type"), "application/json");
  await assert.rejects(gatewayFetch({}, "stripe", "/v1/x", {}, r.f), /only from the app's machine/);
  await assert.rejects(gatewayFetch({ PHOENIX_URL: "https://tt", MACHINE_TOKEN: "m" }, "../admin", "/x", {}, r.f), /not a connection slug/);
});

// ── sending ──────────────────────────────────────────────────────────────────

test("with no sender nothing is sent and the reason is given", async () => {
  const r = recorder();
  assert.deepEqual(await sendEmail({}, msg, r.f), { status: "none", why: "no email sender is connected to this app" });
  assert.equal((await sendEmail({ RESEND_API_KEY: "k" }, msg, r.f)).status, "none"); // no From
  assert.equal((await sendEmail({ RESEND_API_KEY: "k", NOTIFY_FROM: "a@b.example" }, { ...msg, to: [] }, r.f)).status, "none");
  assert.match(String(senderOf({ NOTIFY_VIA: "mailgun" })), /resend or postmark/);
  assert.match(String(senderOf({ NOTIFY_VIA: "resend:resend-2", RESEND_API_KEY: "k" })), /RESEND_2_API_KEY/);
  assert.equal(r.calls.length, 0);
});

test("a key bound at the edge goes straight to the vendor", async () => {
  const r = recorder();
  const out = await sendEmail({ RESEND_API_KEY: "re_1", NOTIFY_FROM: "site@biz.example" }, msg, r.f);
  assert.deepEqual(out, { status: "sent", via: "resend" });
  assert.equal(r.calls[0].url, "https://api.resend.com/emails");
  assert.equal(r.calls[0].headers.get("authorization"), "Bearer re_1");
  assert.equal(r.calls[0].body.subject, "New Bcc: x");
  assert.equal(r.calls[0].body.reply_to, "ann@example.com");
  assert.equal(r.calls[0].body.attachments, undefined);
});

test("NOTIFY_VIA with a slug reads that connection's key name, else goes through the gateway", async () => {
  const r = recorder();
  const bound = await sendEmail({ NOTIFY_VIA: "postmark:postmark-2", POSTMARK_2_API_KEY: "pm2", POSTMARK_API_KEY: "other", NOTIFY_FROM: "a@b.example" }, msg, r.f);
  assert.deepEqual(bound, { status: "sent", via: "postmark" });
  assert.equal(r.calls[0].headers.get("x-postmark-server-token"), "pm2");

  const env = { NOTIFY_VIA: "postmark:postmark-2", PHOENIX_URL: "https://tt.example/", MACHINE_TOKEN: "mt", NOTIFY_FROM: "site@biz.example" };
  assert.deepEqual(await sendEmail(env, msg, r.f), { status: "sent", via: "gateway:postmark-2" });
  assert.equal(r.calls[1].url, "https://tt.example/api/machine/gateway/postmark-2/email");
  assert.equal(r.calls[1].headers.get("authorization"), "Bearer mt");
  assert.equal(r.calls[1].headers.get("x-postmark-server-token"), null);
  assert.equal(r.calls[1].body.To, "owner@example.com");
});

test("an attachment goes as UTF-8 base64 in each vendor's shape", async () => {
  const r = recorder();
  const ics = "BEGIN:VCALENDAR\r\nSUMMARY:Café\r\nEND:VCALENDAR\r\n";
  const attachments = [{ filename: "invite.ics", content: ics, contentType: "text/calendar; charset=utf-8; method=REQUEST" }];
  await sendEmail({ RESEND_API_KEY: "re", NOTIFY_FROM: "a@b.example" }, { ...msg, attachments }, r.f);
  await sendEmail({ POSTMARK_API_KEY: "pm", NOTIFY_FROM: "a@b.example" }, { ...msg, attachments }, r.f);
  const a = r.calls[0].body.attachments[0];
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0))), ics);
  assert.equal(a.content_type, "text/calendar; charset=utf-8; method=REQUEST");
  assert.deepEqual(Object.keys(r.calls[1].body.Attachments[0]), ["Name", "Content", "ContentType"]);
  assert.equal(r.calls[1].body.Attachments[0].Content, a.content);
});

test("a vendor refusal or a network failure is reported, never thrown", async () => {
  const r = recorder(422);
  const out = await sendEmail({ POSTMARK_API_KEY: "pm", NOTIFY_FROM: "a@b.example" }, msg, r.f);
  assert.equal(out.status, "failed");
  const down = (async () => {
    throw new Error("connection reset");
  }) as unknown as typeof fetch;
  assert.deepEqual(await sendEmail({ RESEND_API_KEY: "k", NOTIFY_FROM: "a@b.example" }, msg, down), { status: "failed", via: "resend", error: "connection reset" });
});

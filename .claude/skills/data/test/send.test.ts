import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { connectionsOf, envOf, envVar, setting } from "../env";
import { gatewayFetch, gatewayReachable, listConnections } from "../gateway";
import { sendEmail, senderOf, teamOf } from "../send";
import { emailSender } from "../../booking/notify";

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

test("envOf reads the request's settings by name", async () => {
  const app = new Hono();
  app.get("/", (c) => {
    const env = envOf(c);
    return c.text(typeof env === "function" ? String(env("RESEND_API_KEY") ?? "") : "");
  });
  assert.equal(await (await app.request("/", {}, { RESEND_API_KEY: "re_1" })).text(), "re_1");
});

// ── gateway ──────────────────────────────────────────────────────────────────

test("the gateway call carries the machine token to the slug's path; off the machine it fails plainly", async () => {
  const r = recorder();
  await gatewayFetch({ PHOENIX_URL: "https://tt.example/", MACHINE_TOKEN: "mt" }, "google-calendar", "/calendar/v3/x", { method: "POST", body: "{}" }, r.f);
  assert.equal(r.calls[0].url, "https://tt.example/api/machine/gateway/google-calendar/calendar/v3/x");
  assert.equal(r.calls[0].headers.get("authorization"), "Bearer mt");
  assert.equal(r.calls[0].headers.get("content-type"), "application/json");
  await assert.rejects(gatewayFetch({}, "stripe", "/v1/x", {}, r.f), /No connections here/);
  await assert.rejects(gatewayFetch({ PHOENIX_URL: "https://tt", MACHINE_TOKEN: "m" }, "../admin", "/x", {}, r.f), /not a connection slug/);
});

// Production's connections as the routing Worker hands them over: a stub
// whose fetch takes the machine gateway's address shape, and list().
function fakeTT() {
  const calls: { url: string; init: RequestInit }[] = [];
  const tt = {
    fetch: async (url: string, init: RequestInit = {}) => (calls.push({ url, init }), new Response("ok")),
    list: async () => ({ connections: [{ slug: "google-calendar", provider: "google", service: "calendar", account: "a@b.c" }, { kind: "secret" }] }),
  };
  return { tt, calls };
}

test("in production a call and the listing go through TT; no machine token is sent", async () => {
  const { tt, calls } = fakeTT();
  const r = recorder();
  const env = { TT: tt, PHOENIX_URL: "https://tt.example", MACHINE_TOKEN: "mt" };
  await gatewayFetch(env, "google-calendar", "/calendar/v3/x?a=1", { method: "POST", body: "{}" }, r.f);
  assert.equal(r.calls.length, 0, "the machine gateway is not called");
  assert.equal(calls[0].url, "https://tt/google-calendar/calendar/v3/x?a=1");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("content-type"), "application/json");
  assert.deepEqual((await listConnections(env)).map((c) => c.slug), ["google-calendar"]);
  assert.equal(gatewayReachable({ TT: tt }), true);
  assert.equal(gatewayReachable({}), false);
});

test("envOf hands an object binding over as it is, so TT reaches code that takes an Env", async () => {
  const { tt } = fakeTT();
  const app = new Hono();
  app.get("/", (c) => c.text(connectionsOf(envOf(c)) === tt ? "tt" : "none"));
  assert.equal(await (await app.request("/", {}, { TT: tt })).text(), "tt");
  assert.equal(await (await app.request("/", {}, { incoming: {}, outgoing: {} })).text(), "none");
  // A setting stays text: an object is never a setting.
  assert.equal(setting({ TT: tt }, "TT"), undefined);
});

test("listConnections reads what this app holds, the endpoints only, and says when Task & Tool refuses", async () => {
  const env = { PHOENIX_URL: "https://tt.example/", MACHINE_TOKEN: "mt" };
  const held = [
    { slug: "google-calendar", provider: "google", service: "calendar", account: "me@agency.example", status: "active" },
    { slug: "google-calendar-7c2e1a", provider: "google", service: "calendar", account: "bob@agency.example", status: "active" },
    { env_name: "OPENAI_API_KEY", kind: "secret", provider: "openai-api", status: "active" },
  ];
  const urls: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    urls.push(`${url} ${new Headers(init.headers).get("authorization")}`);
    return Response.json({ ok: true, connections: held });
  }) as unknown as typeof fetch;

  assert.deepEqual(await listConnections(env, f), held.slice(0, 2));
  assert.deepEqual(urls, ["https://tt.example/api/machine/connections Bearer mt"]);
  const refused = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(listConnections(env, refused), /answered 401/);
  await assert.rejects(listConnections({}, f), /No connections here/);
});

// ── sending ──────────────────────────────────────────────────────────────────
// Every send goes through the app's connections: the machine's gateway here
// (production's TT is the same call, data/gateway.ts). No key is ever read.

const MACHINE = { PHOENIX_URL: "https://tt.example/", MACHINE_TOKEN: "mt" };

test("with no sender nothing is sent and the reason is given", async () => {
  const r = recorder();
  assert.deepEqual(await sendEmail({}, msg, r.f), { status: "none", why: "no email sender is connected to this app" });
  assert.equal((await sendEmail({ ...MACHINE, NOTIFY_VIA: "resend" }, msg, r.f)).status, "none"); // no From
  assert.equal((await sendEmail({ ...MACHINE, NOTIFY_VIA: "resend", NOTIFY_FROM: "a@b.example" }, { ...msg, to: [] }, r.f)).status, "none");
  assert.match(String(senderOf({ ...MACHINE, NOTIFY_VIA: "mailgun" })), /resend, postmark or taskandtool/);
  assert.equal(r.calls.length, 0);
});

test("NOTIFY_VIA names the owner's sender, its slug when not the vendor's name; a bound key is never read", async () => {
  const r = recorder();
  const env = { ...MACHINE, NOTIFY_VIA: "postmark:postmark-2", POSTMARK_2_API_KEY: "pm2", NOTIFY_FROM: "site@biz.example" };
  assert.deepEqual(await sendEmail(env, msg, r.f), { status: "sent", via: "postmark" });
  assert.equal(r.calls[0].url, "https://tt.example/api/machine/gateway/postmark-2/email");
  assert.equal(r.calls[0].headers.get("authorization"), "Bearer mt");
  assert.equal(r.calls[0].headers.get("x-postmark-server-token"), null);
  assert.equal(r.calls[0].body.To, "owner@example.com");
  assert.equal(r.calls[0].body.Subject, "New Bcc: x");

  await sendEmail({ ...MACHINE, NOTIFY_VIA: "resend", NOTIFY_FROM: "site@biz.example" }, msg, r.f);
  assert.equal(r.calls[1].url, "https://tt.example/api/machine/gateway/resend/emails");
  assert.equal(r.calls[1].body.reply_to, "ann@example.com");
  assert.equal(r.calls[1].body.attachments, undefined);
});

test("an attachment goes as UTF-8 base64 in each vendor's shape", async () => {
  const r = recorder();
  const ics = "BEGIN:VCALENDAR\r\nSUMMARY:Café\r\nEND:VCALENDAR\r\n";
  const attachments = [{ filename: "invite.ics", content: ics, contentType: "text/calendar; charset=utf-8; method=REQUEST" }];
  await sendEmail({ ...MACHINE, NOTIFY_VIA: "resend", NOTIFY_FROM: "a@b.example" }, { ...msg, attachments }, r.f);
  await sendEmail({ ...MACHINE, NOTIFY_VIA: "postmark", NOTIFY_FROM: "a@b.example" }, { ...msg, attachments }, r.f);
  const a = r.calls[0].body.attachments[0];
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0))), ics);
  assert.equal(a.content_type, "text/calendar; charset=utf-8; method=REQUEST");
  assert.deepEqual(Object.keys(r.calls[1].body.Attachments[0]), ["Name", "Content", "ContentType"]);
  assert.equal(r.calls[1].body.Attachments[0].Content, a.content);
});

test("a vendor refusal or a network failure is reported, never thrown", async () => {
  const r = recorder(422);
  const out = await sendEmail({ ...MACHINE, NOTIFY_VIA: "postmark", NOTIFY_FROM: "a@b.example" }, msg, r.f);
  assert.equal(out.status, "failed");
  const down = (async () => {
    throw new Error("connection reset");
  }) as unknown as typeof fetch;
  assert.deepEqual(await sendEmail({ ...MACHINE, NOTIFY_VIA: "resend", NOTIFY_FROM: "a@b.example" }, msg, down), { status: "failed", via: "resend", error: "connection reset" });
});

// ── Task & Tool email ────────────────────────────────────────────────────────

function answering(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { calls, f };
}

test("Task & Tool email is the sender unless NOTIFY_VIA names another", () => {
  assert.equal((senderOf(MACHINE) as { vendor: string }).vendor, "taskandtool");
  assert.equal((senderOf({ ...MACHINE, RESEND_API_KEY: "re" }) as { vendor: string }).vendor, "taskandtool", "a key here chooses nothing");
  assert.equal((senderOf({ ...MACHINE, NOTIFY_VIA: "resend" }) as { vendor: string }).vendor, "resend");
});

test("team mail goes through the connection Task & Tool answers; no From is needed", async () => {
  const r = answering({ sent: ["owner@example.com"], skipped: ["ann@example.com"], failed: [] });
  const out = await sendEmail(MACHINE, { ...msg, to: ["owner@example.com", "ann@example.com"], team: true }, r.f);
  assert.deepEqual(out, { status: "sent", via: "taskandtool", skipped: ["ann@example.com"] });
  assert.equal(r.calls[0].url, "https://tt.example/api/machine/gateway/taskandtool-email/emails");
  assert.equal(r.calls[0].headers.get("authorization"), "Bearer mt");
  assert.deepEqual(r.calls[0].body, { to: ["owner@example.com", "ann@example.com"], subject: "New Bcc: x", text: "Hi", reply_to: "ann@example.com" });
});

test("nobody on the app is not sent, and says who; not turned on is no sender", async () => {
  const r = answering({ sent: [], skipped: ["ann@example.com"], failed: [] });
  assert.deepEqual(await sendEmail(MACHINE, { ...msg, to: ["ann@example.com"], team: true }, r.f), {
    status: "none",
    why: "ann@example.com cannot open this app in Task & Tool",
  });
  const off = answering({ error: "unknown_connection" }, 404, { "x-tasktool-refusal": "unknown_connection" });
  assert.deepEqual(await sendEmail(MACHINE, { ...msg, team: true }, off.f), { status: "none", why: "no email sender is connected to this app" });
});

test("a customer's email never reaches Task & Tool", async () => {
  const r = answering({});
  const out = await sendEmail(MACHINE, msg, r.f);
  assert.equal(out.status, "none");
  assert.match((out as { why: string }).why, /connect Resend or Postmark/);
  assert.equal(r.calls.length, 0);
  assert.equal(emailSender(MACHINE), null, "booking confirmations need a sender that reaches customers");
});

test("a refusal is a failure with its reason", async () => {
  const r = answering({ error: "subject is required" }, 422);
  const out = await sendEmail(MACHINE, { ...msg, team: true }, r.f);
  assert.equal(out.status, "failed");
  assert.match((out as { error: string }).error, /422 .*subject is required/);
});

test("teamOf lists who Task & Tool email reaches, and is null for any other sender", async () => {
  const r = answering({ people: [{ name: "Pat", email: "pat@example.com" }] });
  assert.deepEqual(await teamOf(MACHINE, r.f), [{ name: "Pat", email: "pat@example.com" }]);
  assert.equal(r.calls[0].url, "https://tt.example/api/machine/gateway/taskandtool-email/people");
  assert.equal(await teamOf({ ...MACHINE, NOTIFY_VIA: "resend", NOTIFY_FROM: "a@b.example" }, r.f), null);
  assert.equal(await teamOf(MACHINE, answering({}, 401).f), null);
});

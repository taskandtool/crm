// The phone skill's pages as this CRM mounts them, over HTTP against a
// scratch schema: Settings, Phone and texts without Twilio (the Connect
// panel and the flows' pictures), the switches, Messages and its sidebar
// link once there is a number, a thread and its reply, the contact page's
// texts and Don't text, the bell, a short link. Skipped without TEST_DATABASE_URL.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import app from "../src/app";
import { seeds } from "../src/config";
import type { Db } from "../src/data/db";
import { setup } from "../src/db/setup";
import type { Runtime } from "../src/runtime";
import { scratch, type Scratch } from "./scratch";

const HOST = "https://crm.example";
const ME = { "x-tasktool-user": "ann@team.example", host: "crm.example" };

let s: Scratch | null = null;
let skip: string | false = false;
let db: Db;
let runtime: Runtime;

before(async () => {
  delete process.env.ADMIN_DEV_USER;
  delete process.env.TWILIO_API_KEY;
  const r = await scratch("phone");
  if (typeof r === "string") {
    skip = r;
    return;
  }
  s = r;
  db = r.db;
  await setup(db, seeds);
  runtime = { open: () => ({ db }) };
});
after(async () => {
  await s?.drop();
});

const get = (path: string, headers: Record<string, string> = ME) => app.request(HOST + path, { headers }, { runtime });
const post = (path: string, form: Record<string, string>) =>
  app.request(HOST + path, { method: "POST", body: new URLSearchParams(form), headers: { ...ME, origin: HOST, "content-type": "application/x-www-form-urlencoded" } }, { runtime });

test("without Twilio: Settings says how to connect it and shows the six flows; Messages stays out of the sidebar", async (t) => {
  if (skip) return t.skip(skip);
  const settings = await (await get("/settings")).text();
  assert.match(settings, /Phone and texts/);
  const page = await (await get("/phone")).text();
  assert.match(page, /Connect Twilio for a business number/);
  assert.match(page, /Connect my Twilio account so customers can call and text my business number\./);
  for (const name of ["Missed call", "Thanks for reaching out", "Stopped before booking", "Booked", "Looking forward to it", "After the visit"]) assert.match(page, new RegExp(name));
  assert.equal(await (await get("/nav/messages")).text(), "<span></span>");
});

test("a flow's picture shows its steps and its words filled in, and its switch turns it off", async (t) => {
  if (skip) return t.skip(skip);
  const pic = await (await get("/phone/flows/unbooked")).text();
  assert.match(pic, /Sends/);
  // No texting here yet: the text is still shown and editable, the email it sends for now beside it.
  assert.match(pic, /Until your number can text, this goes by email where it can/);
  assert.match(pic, /Reply 1, 2 or 3 to book/);
  assert.match(pic, /<summary[^>]*>Edit<\/summary>/);
  assert.match(pic, /Subject: Pick a time for your/);
  assert.match(pic, /No form has &quot;Follow up automatically&quot; on yet|No form has "Follow up automatically" on yet/);
  assert.match(pic, /Stops early when: they book/);
  const off = await post("/phone/flows/unbooked", { enabled: "0", return: "flow" });
  assert.equal(off.status, 303);
  assert.match(off.headers.get("location") ?? "", /^\/phone\/flows\/unbooked\?saved=flow/);
  const [row] = await db.sql<{ enabled: boolean }>`select enabled from text_flows where key = 'unbooked'`;
  assert.equal(row.enabled, false);
  await post("/phone/flows/unbooked", { enabled: "1" });
});

test("with a number: Messages in the sidebar, a thread from a text, and the reply refused until texting is approved", async (t) => {
  if (skip) return t.skip(skip);
  const [n] = await db.sql<{ id: string }>`
    insert into phone_numbers (e164, provider_id, ring_to, hook_secret_hash) values ('+15125550100', 'PN1', '+15125559999', 'x') returning id::text as id`;
  const [c] = await db.sql<{ id: string }>`insert into customers (name, phone, stage) values ('Natalie Ruiz', '(512) 555-0123', 'lead') returning id::text as id`;
  await db.sql`
    insert into communications (phone_number_id, local_e164, remote_e164, remote_key, contact_id, kind, direction, status, body, provider_id)
    values (${n.id}::bigint, '+15125550100', '+15125550123', '5125550123', ${c.id}::bigint, 'text', 'in', 'received', 'Can you come Thursday?', 'SM1')`;
  assert.match(await (await get("/nav/messages")).text(), /href="\/messages"/);
  assert.match(await (await get("/messages/count")).text(), />1</);
  const list = await (await get("/messages")).text();
  assert.match(list, /Natalie Ruiz/);
  assert.match(list, /Can you come Thursday\?/);
  const thread = await (await get("/messages/5125550123")).text();
  assert.match(thread, /Texting starts when Twilio approves your number|Replies go once your number can text/);
  assert.doesNotMatch(await (await get("/messages/count")).text(), />1</, "opening it reads it");
  const reply = await post("/messages/5125550123/reply", { to: "+15125550123", body: "Yes, 2pm works" });
  assert.equal(reply.status, 422);
  assert.match(await reply.text(), /Twilio isn&#39;t connected|Twilio isn't connected/);
  // The bell has it, and opens the thread.
  const bell = (await (await get("/notifications")).text()).replace(/<[^>]+>/g, "");
  assert.match(bell, /Natalie Ruiz texted: Can you come Thursday\?/);
});

test("the contact page shows their texts and calls, and Don't text opts them out", async (t) => {
  if (skip) return t.skip(skip);
  const [c] = await db.sql<{ id: string }>`select id::text as id from customers where name = 'Natalie Ruiz'`;
  const page = await (await get(`/customers/${c.id}`)).text();
  assert.match(page, /Texts and calls/);
  assert.match(page, /Can you come Thursday\?/);
  const off = await post(`/customers/${c.id}/texts-off`, { texts_off: "1" });
  assert.equal(off.status, 303);
  assert.match(await (await get(`/customers/${c.id}`)).text(), /Marked Don(&#39;|')t text/);
  await post(`/customers/${c.id}/texts-off`, { texts_off: "0" });
});

test("a short link on the CRM's /q opens the path it stands for, once its code is known", async (t) => {
  if (skip) return t.skip(skip);
  await db.sql`insert into short_links (code, url, expires_at) values ('abcdEFGH', '/q/book/furnace?k=x', now() + interval '1 day')`;
  const r = await app.request(HOST + "/q/t/abcdEFGH", { headers: { host: "crm.example" } }, { runtime });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/q/book/furnace?k=x");
  assert.equal((await app.request(HOST + "/q/t/nope1234", { headers: { host: "crm.example" } }, { runtime })).status, 404);
});

test("Twilio's webhooks need the number's secret", async (t) => {
  if (skip) return t.skip(skip);
  const [n] = await db.sql<{ id: string }>`select id::text as id from phone_numbers limit 1`;
  const r = await app.request(`${HOST}/hooks/twilio/voice?n=${n.id}`, { method: "POST", body: "CallSid=CA1&From=%2B15125550111", headers: { host: "crm.example", "content-type": "application/x-www-form-urlencoded" } }, { runtime });
  assert.equal(r.status, 401);
});

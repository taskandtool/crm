import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scratch } from "../../data/test/scratch";
import { findCalendars, linkAccounts } from "../calendars";
import { addCalendar, calendars } from "../hours";
import { fake, held, json, team, withDb } from "./calendar-fixtures";

const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"), "utf8");

const calendarRows = async (s: Scratch) =>
  (await s.db.sql`select r.name, k.connection, k.external_id from calendars k join resources r on r.id = k.resource_id order by r.name, k.connection`)
    .map((k) => `${k.name} ${k.connection} ${k.external_id}`);

const connected = [
  held("google-calendar", "google", "pat@example.com"),
  held("google-calendar-7c2e1a", "google", "sam@example.com"),
  held("microsoft-calendar", "microsoft", "someone@elsewhere.example"),
  held("google-gmail", "google", "pat@example.com", "gmail"),
];

// ---- linkAccounts ----------------------------------------------------------------

test("linkAccounts lists the calendar connections held and gives each to the person whose email it is", (t) =>
  withDb(t, async (s) => {
    await team(s, schema);
    assert.equal(await linkAccounts(s.db, connected), 2);
    assert.deepEqual(await calendarRows(s), ["Pat google-calendar primary", "Sam google-calendar-7c2e1a primary"]);
    assert.deepEqual((await s.db.sql`select connection from calendar_accounts order by connection`).map((a) => a.connection),
      ["google-calendar", "google-calendar-7c2e1a", "microsoft-calendar"], "calendars only, matched to a person or not");
  }));

test("linkAccounts gives an account only once: one someone removed stays removed, and one no longer held drops off", (t) =>
  withDb(t, async (s) => {
    const [, sam] = await team(s, schema);
    await linkAccounts(s.db, connected);
    await s.db.sql`delete from calendars where resource_id = ${sam.id}::bigint`;
    assert.equal(await linkAccounts(s.db, connected.slice(0, 2)), 0);
    assert.deepEqual(await calendarRows(s), ["Pat google-calendar primary"]);
    assert.equal((await s.db.sql`select 1 from calendar_accounts`).length, 2);
  }));

// ---- findCalendars ---------------------------------------------------------------

test("findCalendars merges what each Google account sees, the account that can add bookings first", (t) =>
  withDb(t, async (s) => {
    await team(s, schema);
    await linkAccounts(s.db, [held("google-calendar", "google", "pat@example.com"), held("google-calendar-7c2e1a", "google", "sam@example.com")]);
    const { calls, gw } = fake({
      // Pat's account: Pat's own calendar, Sam's shared to read, and a team calendar over two pages.
      "GET /google-calendar/calendar/v3/users/me/calendarList": (c) =>
        new URL(c.url).searchParams.get("pageToken") === "p2"
          ? json({ items: [{ id: "team@group.calendar.google.com", summary: "Jobs", accessRole: "writer" }] })
          : json({
              items: [
                { id: "pat@example.com", summary: "pat@example.com", accessRole: "owner", primary: true },
                { id: "sam@example.com", summary: "sam@example.com", accessRole: "reader" },
              ],
              nextPageToken: "p2",
            }),
      // Sam's account: Sam's own calendar.
      "GET /google-calendar-7c2e1a/calendar/v3/users/me/calendarList": () =>
        json({ items: [{ id: "sam@example.com", summary: "sam@example.com", accessRole: "owner", primary: true }] }),
    });

    const found = await findCalendars(s.db, gw);
    assert.deepEqual(found, {
      calendars: [
        { name: "Jobs", options: [{ connection: "google-calendar", account: "pat@example.com", externalId: "team@group.calendar.google.com", canEdit: true }] },
        { name: "pat@example.com", options: [{ connection: "google-calendar", account: "pat@example.com", externalId: "primary", canEdit: true }] },
        {
          name: "sam@example.com",
          options: [
            { connection: "google-calendar-7c2e1a", account: "sam@example.com", externalId: "primary", canEdit: true },
            { connection: "google-calendar", account: "pat@example.com", externalId: "sam@example.com", canEdit: false },
          ],
        },
      ],
      errors: [],
    });
    assert.equal(new URL(calls[0].url).searchParams.get("minAccessRole"), "reader", "free/busy alone cannot be read");
  }));

test("findCalendars lists Microsoft's own and shared calendars, and names an account it could not ask", (t) =>
  withDb(t, async (s) => {
    await team(s, schema);
    await linkAccounts(s.db, [held("google-calendar", "google", "pat@example.com"), held("microsoft-calendar", "microsoft", "sam@example.com")]);
    const { gw } = fake({
      "GET /google-calendar/": () => new Response('{"error":"needs_reconnect"}', { status: 409, headers: { "x-tasktool-refusal": "needs_reconnect" } }),
      "GET /microsoft-calendar/v1.0/me/calendars": (c) =>
        c.path.includes("skiptoken")
          ? json({ value: [{ id: "AAMkShared", name: "Calendar", canEdit: false, owner: { address: "lee@example.com" } }] })
          : json({
              value: [{ id: "AAMkOwn", name: "Calendar", canEdit: true, isDefaultCalendar: true, owner: { address: "sam@example.com" } }],
              "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendars?$skiptoken=2",
            }),
    });

    const found = await findCalendars(s.db, gw);
    assert.deepEqual(found.calendars, [
      { name: "Calendar", options: [{ connection: "microsoft-calendar", account: "sam@example.com", externalId: "primary", canEdit: true }] },
      { name: "lee@example.com: Calendar", options: [{ connection: "microsoft-calendar", account: "sam@example.com", externalId: "AAMkShared", canEdit: false }] },
    ]);
    assert.equal(found.errors.length, 1);
    assert.match(found.errors[0], /^pat@example\.com: .*needs_reconnect/);
  }));

// ---- addCalendar -----------------------------------------------------------------

test("addCalendar attaches a found calendar through a held account, once", (t) =>
  withDb(t, async (s) => {
    const [pat] = await team(s, schema);
    await linkAccounts(s.db, [held("google-calendar-7c2e1a", "google", "sam@example.com")]);
    // Sam's account, reading Pat's calendar that Pat shares with Sam.
    const attach = { connection: "google-calendar-7c2e1a", external_id: "pat@example.com", name: "Pat (shared)", bookings: "0" };
    assert.deepEqual(await addCalendar(s.db, pat.id, attach, "o@example.com"), { ok: true, value: null });
    const [k] = await calendars(s.db, pat.id);
    assert.deepEqual([k.provider, k.connection, k.account, k.external_id, k.name, k.receives_bookings],
      ["google", "google-calendar-7c2e1a", "sam@example.com", "pat@example.com", "Pat (shared)", false]);

    assert.deepEqual(await addCalendar(s.db, pat.id, attach, "o@example.com"), { ok: false, errors: { calendar: "This calendar is already added." } });
    assert.deepEqual(await addCalendar(s.db, pat.id, { ...attach, connection: "google-calendar-ffffff" }, "o@example.com"),
      { ok: false, errors: { calendar: "That calendar is no longer available. Show the available calendars again." } });
  }));

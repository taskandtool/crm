import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeText, fold, icsTime, invite } from "../ics";

const booking = { id: "42", starts_at: new Date("2026-03-09T15:00:00Z"), ends_at: new Date("2026-03-09T15:30:00Z"), sequence: 0, name: 'Ann "A" Lee', email: "ann@example.com" };
const base = { booking, domain: "acme.com", organizer: { email: "owner@acme.com", name: "Acme" }, summary: "Intro call", now: new Date("2026-03-01T12:00:00.123Z") };
const unfold = (s: string) => s.replace(/\r\n /g, "");
const octets = (s: string) => new TextEncoder().encode(s).length;

test("text escapes backslash, semicolon, comma and every newline", () => {
  assert.equal(escapeText("a\\b;c,d\ne\r\nf\rg"), String.raw`a\\b\;c\,d\ne\nf\ng`);});

test("times are UTC with Z", () => {
  assert.equal(icsTime(new Date("2026-03-09T15:00:00.999Z")), "20260309T150000Z");
});

test("lines fold at 75 octets without splitting a multi-byte character", () => {
  const long = "DESCRIPTION:" + "é".repeat(40) + "😀".repeat(20) + "x".repeat(100);
  const folded = fold(long);
  for (const line of folded.split("\r\n")) assert.ok(octets(line) <= 75, `${octets(line)}: ${line}`);
  assert.equal(unfold(folded), long);
  assert.ok(!folded.includes("�"));
  for (const line of folded.split("\r\n").slice(1)) assert.ok(line.startsWith(" "));
  assert.equal(fold("SHORT:x"), "SHORT:x");
  assert.equal(fold("A".repeat(75)), "A".repeat(75));
  assert.equal(fold("A".repeat(76)), "A".repeat(75) + "\r\n A");
});

test("a REQUEST has a stable UID, the SEQUENCE, CRLF lines and escaped text", () => {
  const text = invite({ ...base, method: "REQUEST", description: "Bring notes; agenda, part 1\nPart 2", location: "Room 4, Floor 2" });
  assert.ok(text.endsWith("\r\n"));
  assert.ok(!/[^\r]\n/.test(text), "every newline is CRLF");
  const lines = unfold(text).split("\r\n");
  for (const want of [
    "METHOD:REQUEST", "UID:booking-42@acme.com", "SEQUENCE:0", "DTSTAMP:20260301T120000Z", "DTSTART:20260309T150000Z",
    "DTEND:20260309T153000Z", "SUMMARY:Intro call", String.raw`DESCRIPTION:Bring notes\; agenda\, part 1\nPart 2`, "LOCATION:Room 4\\, Floor 2",
    'ORGANIZER;CN="Acme":mailto:owner@acme.com', "STATUS:CONFIRMED",
  ]) assert.ok(lines.includes(want), want);
  assert.ok(lines.some((l) => l.startsWith('ATTENDEE;CN="Ann A Lee";') && l.endsWith(":mailto:ann@example.com")), "quotes are dropped from a CN");
  assert.equal(lines[0], "BEGIN:VCALENDAR");
});

test("a CANCEL keeps the UID, carries the higher SEQUENCE and says CANCELLED", () => {
  const text = unfold(invite({ ...base, method: "CANCEL", booking: { ...booking, sequence: 2 } }));
  for (const want of ["METHOD:CANCEL", "UID:booking-42@acme.com", "SEQUENCE:2", "STATUS:CANCELLED"]) assert.ok(text.split("\r\n").includes(want), want);
});

test("a newline cannot inject a property", () => {
  const text = unfold(invite({ ...base, method: "REQUEST", summary: "Hi\r\nATTENDEE:mailto:evil@x.com", booking: { ...booking, name: "A\r\nB", email: "ann@example.com\r\nX:1" } }));
  assert.equal(text.split("\r\n").filter((l) => l.startsWith("ATTENDEE")).length, 1);
  assert.ok(!text.split("\r\n").some((l) => l.startsWith("X:")));
});

test("a download may leave out the organizer; an invitation may not", () => {
  const text = invite({ ...base, organizer: null, method: "PUBLISH" });
  assert.ok(!text.includes("ORGANIZER"));
  assert.throws(() => invite({ ...base, organizer: null, method: "REQUEST" }), /organizer/);
});

test("a download (PUBLISH) names no attendee; an invitation does", () => {
  const lines = (m: "PUBLISH" | "REQUEST" | "CANCEL") => unfold(invite({ ...base, method: m })).split("\r\n");
  assert.ok(!lines("PUBLISH").some((l) => l.startsWith("ATTENDEE")), "RFC 5546: no ATTENDEE in a PUBLISH");
  assert.ok(lines("REQUEST").some((l) => l.startsWith("ATTENDEE")));
  assert.ok(lines("CANCEL").some((l) => l.startsWith("ATTENDEE")));
});

test("control characters other than newlines are dropped from text", () => {
  assert.equal(escapeText("a\x00b\x07c\td\x1be\x7f"), "abc\tde");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_FILL_MS, SpamFields, makeStamp, verdict } from "../spam";

test("the honeypot and a missing, unsigned or forged stamp drop the post; a fast one is spam", async () => {
  const now = 1_800_000_000_000;
  const stamp = await makeStamp("contact", now);
  assert.equal(await verdict("contact", { stamp }, now + MIN_FILL_MS), "ok");
  assert.equal(await verdict("contact", { stamp }, now + 500), "fast");
  assert.equal(await verdict("contact", { stamp, honeypot: "http://spam" }, now + 60_000), "drop");
  assert.equal(await verdict("contact", { stamp: "" }, now), "drop");
  // an unsigned or re-timed stamp, one from the future, or one for another form
  assert.equal(await verdict("contact", { stamp: String(now - 60_000) }, now), "drop");
  assert.equal(await verdict("contact", { stamp: stamp.replace(/^\d+/, String(now - 60_000)) }, now), "drop");
  assert.equal(await verdict("contact", { stamp: await makeStamp("contact", now + 600_000) }, now), "drop");
  assert.equal(await verdict("quote", { stamp }, now + 10_000), "drop");
  assert.equal(await verdict("contact", { stamp: stamp + "!" }, now + 10_000), "drop");
});

test("the honeypot sits off screen, not display:none, out of the keyboard and screen reader path", () => {
  const html = String(SpamFields({ stamp: "123" }));
  assert.match(html, /position:absolute;left:-10000px/);
  assert.doesNotMatch(html, /display:\s*none|class="hidden"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /name="company_website"[^>]*tabindex="-1"|tabindex="-1"[^>]*name="company_website"/);
  assert.match(html, /<input type="hidden" name="_started" value="123"/);
});

test("a honeypot sent as a file is a bot", async () => {
  const now = 1_800_000_000_000;
  const stamp = await makeStamp("x", now);
  assert.equal(await verdict("x", { stamp, honeypot: "" }, now + 10_000), "ok");
  assert.equal(await verdict("x", { stamp, honeypot: new Blob(["x"]) }, now + 10_000), "drop");
});

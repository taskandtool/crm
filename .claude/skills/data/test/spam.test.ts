import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_FILL_MS, SpamFields, makeStamp, verdict } from "../spam";

test("the honeypot and a missing or forged stamp drop the post; a fast one is spam", async () => {
  const now = 1_800_000_000_000;
  for (const secret of [undefined, "s3cret"]) {
    const stamp = await makeStamp("contact", secret, now);
    assert.equal(await verdict("contact", { stamp }, secret, now + MIN_FILL_MS), "ok");
    assert.equal(await verdict("contact", { stamp }, secret, now + 500), "fast");
    assert.equal(await verdict("contact", { stamp, honeypot: "http://spam" }, secret, now + 60_000), "drop");
    assert.equal(await verdict("contact", { stamp: "" }, secret, now), "drop");
    assert.equal(await verdict("contact", { stamp: String(now + 600_000) }, secret, now), "drop");
  }
  // With a secret, an unsigned or re-timed stamp, or one for another form, is refused.
  const signed = await makeStamp("contact", "s3cret", now);
  assert.equal(await verdict("contact", { stamp: String(now - 60_000) }, "s3cret", now), "drop");
  assert.equal(await verdict("contact", { stamp: signed.replace(/^\d+/, String(now - 60_000)) }, "s3cret", now), "drop");
  assert.equal(await verdict("quote", { stamp: signed }, "s3cret", now + 10_000), "drop");
  assert.equal(await verdict("contact", { stamp: signed + "!" }, "s3cret", now + 10_000), "drop");
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
  const stamp = await makeStamp("x", undefined, now);
  assert.equal(await verdict("x", { stamp, honeypot: "" }, undefined, now + 10_000), "ok");
  assert.equal(await verdict("x", { stamp, honeypot: new Blob(["x"]) }, undefined, now + 10_000), "drop");
});

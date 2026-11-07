// Where a visitor came from, with no database: what is kept, what is refused,
// and the layout's script, run against a fake page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { cameFrom, ORIGIN_SCRIPT, readOrigin, sourceRows, token } from "../origin";

test("Meta's ad names survive, lowercased; markup and addresses do not", () => {
  assert.equal(token("Roof Offer | 4:5 (v2)"), "roof-offer-|-4:5-(v2)");
  assert.equal(token("  Spring   Sale "), "spring-sale");
  assert.equal(token("Ünder 25%"), "ünder-25%");
  assert.equal(token("a&b"), "a-b");
  assert.equal(token("Bob's Roof"), "bobs-roof");
  assert.equal(token("<script>"), null);
  assert.equal(token("ann@example.com"), null);
  assert.equal(token("!!!"), null);
  assert.equal(token(7), null);
  assert.equal(token("x".repeat(500))?.length, 120);
});

test("a page's own tags win; the cookie fills in when the page has none, and says the first visit", () => {
  const cookie = (first: string, last: string) => `other=1; tt_touch=${encodeURIComponent(new URLSearchParams({ first, last }).toString())}; more=2`;
  const c = cookie("utm_source=google&utm_campaign=brand&page=/", "utm_source=facebook&utm_content=ad-1&fbclid=AbC_1&page=/roof");

  assert.deepEqual(readOrigin("", "", c), {
    _utm: { source: "facebook", content: "ad-1" }, _click: { fbclid: "AbC_1" }, _landing: "/roof",
    _first: { utm: { source: "google", campaign: "brand" }, page: "/" },
  });
  const own = readOrigin("source=email&campaign=october&gclid=G", "news.example", c);
  assert.deepEqual(own._utm, { source: "email", campaign: "october" });
  assert.deepEqual(own._click, { gclid: "G" });
  assert.equal(own._referrer, "news.example");
  assert.equal(own._landing, undefined);
  assert.deepEqual(own._first?.utm, { source: "google", campaign: "brand" });

  // Landing on the form's own page: its tags match the cookie's, which alone has the page.
  assert.equal(readOrigin("source=facebook&content=ad-1&fbclid=AbC_1", "", c)._landing, "/roof");

  // One visit is both first and last: no _first.
  const once = cookie("utm_source=facebook&page=/roof", "utm_source=facebook&page=/roof");
  assert.equal(readOrigin("", "", once)._first, undefined);

  // The cookie is the visitor's to change.
  assert.deepEqual(readOrigin("", "", cookie("utm_source=<x>", "fbclid=not%20an%20id&page=/a<b")), {});
  assert.deepEqual(readOrigin("", "", "tt_touch=%E0%A4%A"), {});
  assert.deepEqual(readOrigin("", "", null), {});
  assert.deepEqual(readOrigin("x".repeat(2000), "", null), {});
  assert.equal(cameFrom(readOrigin("", "", c)), "facebook");
});

/** Runs the script for one page view; the cookie jar is a string, as document.cookie reads. */
function visit(url: string, jar: { cookie: string; set?: string }) {
  const u = new URL(url);
  const document = {
    get cookie() {
      return jar.cookie;
    },
    set cookie(v: string) {
      jar.cookie = v.split(";")[0];
      jar.set = v;
    },
  } as { cookie: string };
  const page = { location: { search: u.search, pathname: u.pathname, protocol: u.protocol }, document, URLSearchParams, encodeURIComponent, decodeURIComponent };
  runInNewContext(ORIGIN_SCRIPT, page);
}

test("the script keeps the first and last tagged visits, and an untagged visit only the page it arrived on", () => {
  const untagged = { cookie: "" } as { cookie: string; set?: string };
  visit("https://site.example/about", untagged);
  assert.match(untagged.set!, /^tt_land=%2Fabout; Path=\/; SameSite=Lax; Secure$/, "gone when the browser closes");
  assert.equal(readOrigin("", "", untagged.cookie)._landing, "/about");

  const jar = { cookie: "" } as { cookie: string; set?: string };
  visit("https://site.example/roof?utm_source=Google&utm_campaign=brand", jar);
  assert.match(jar.set!, /Path=\/; Max-Age=2592000; SameSite=Lax; Secure$/);
  assert.equal(readOrigin("", "", jar.cookie)._utm?.source, "google");

  visit("https://site.example/services", jar);
  assert.equal(readOrigin("", "", jar.cookie)._utm?.source, "google", "a later page with no tags changes nothing");

  visit("https://site.example/offer?utm_source=facebook&fbclid=F1", jar);
  const both = readOrigin("", "", jar.cookie);
  assert.equal(both._utm?.source, "facebook");
  assert.equal(both._click?.fbclid, "F1");
  assert.equal(both._landing, "/offer");
  assert.equal(both._first?.utm?.source, "google");
  assert.equal(both._first?.page, "/roof");
});

test("the script keeps a utm_ field it has no name for", () => {
  const jar = { cookie: "" } as { cookie: string; set?: string };
  visit("https://site.example/roof?utm_source=facebook&utm_id=123", jar);
  assert.equal(readOrigin("", "", jar.cookie)._utm?.id, "123");
});

test("any other utm_ field is kept under its own name, bounded", () => {
  const got = readOrigin("utm_source=facebook&utm_id=123&utm_Custom_Thing=Hello%20There&utm_%3Cx%3E=no&utm_bad=%3Cscript%3E", "");
  assert.deepEqual(got._utm, { source: "facebook", custom_thing: "hello-there", id: "123" });
  const many = Array.from({ length: 30 }, (_, i) => `utm_x${String(i).padStart(2, "0")}=1`).join("&");
  assert.equal(Object.keys(readOrigin(many, "")._utm ?? {}).length, 10);
});

test("the landing page is known without a tag: from the cookie, else the form's page", () => {
  assert.equal(readOrigin("", "", "tt_land=%2Froof")._landing, "/roof");
  assert.equal(readOrigin("", "", undefined, "/quote")._landing, "/quote");
  assert.equal(readOrigin("", "", "tt_land=%2Froof", "/quote")._landing, "/roof");
  assert.equal(readOrigin("", "", undefined, "/forms/a/start")._landing, undefined);
  assert.equal(readOrigin("", "", undefined, "/q/forms/a/start")._landing, undefined);
  assert.equal(readOrigin("", "", "tt_land=<script>", undefined)._landing, undefined);
});

test("a submission's source reads as its UTM fields, under their own names", () => {
  const rows = sourceRows({ _utm: { source: "facebook", campaign: "fall-sale", term: "west", id: "9" }, _landing: "/roof" }, "Ad set");
  const shown = Object.fromEntries(rows.filter((r) => r.value).map((r) => [r.label, r.value]));
  assert.deepEqual(shown, { "Landing page": "/roof", Source: "facebook", Campaign: "fall sale", "Ad set": "west", id: "9" });
  assert.equal(sourceRows({ _referrer: "google.com" }).find((r) => r.label === "Source")?.value, "google.com");
});

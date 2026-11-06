import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { Hono } from "hono";
import { teamOnly } from "../guard";
import { When } from "../list";
import { shownZone, viewerZone, ViewerZoneScript } from "../viewer";

const NOW = new Date("2026-03-01T12:00:00Z");
const NEW_YORK = "tt_zone=America%2FNew_York";
const KOLKATA = "tt_zone=Asia/Kolkata";

/** A team page and a public page, each showing `at`; the business is in Chicago. */
function site(at: string) {
  const app = new Hono();
  app.get("/public", (c) => c.html(<When at={at} timeZone="America/Chicago" now={NOW} />));
  app.use("/team/*", teamOnly());
  // A skill's routes guard themselves too.
  app.use("/team/*", teamOnly());
  app.get("/team/when", (c) => c.html(<When at={at} timeZone="America/Chicago" now={NOW} />));
  app.get("/team/pinned", (c) => c.html(<When at={at} timeZone="America/Chicago" pin now={NOW} />));
  app.get("/team/zone", (c) => c.text(viewerZone(c, "America/Chicago")));
  const Shown = () => <b>{shownZone("America/Chicago")}</b>;
  app.get("/team/shown", (c) => c.html(<Shown />));
  return async (path: string, cookie?: string) =>
    (await app.request(path, { headers: { "x-tasktool-user": "ann@team.example", ...(cookie ? { cookie } : {}) } })).text();
}

test("the same instant reads in each person's own zone, the business's until theirs is known", async () => {
  const get = site("2026-06-15T14:30:00Z");
  assert.match(await get("/team/when", NEW_YORK), /Jun 15, 10:30\sAM/);
  assert.match(await get("/team/when", KOLKATA), /Jun 15, 8:00\sPM/);
  assert.match(await get("/team/when"), /Jun 15, 9:30\sAM/);
  assert.equal(await get("/team/zone", KOLKATA), "Asia/Kolkata");
  assert.equal(await get("/team/zone"), "America/Chicago");
  assert.match(await get("/team/shown", KOLKATA), /Asia\/Kolkata/);
  assert.match(await get("/team/shown"), /America\/Chicago/);
});

test("across a clock change: New York skips an hour, Kolkata does not", async () => {
  const before = site("2026-03-08T06:59:00Z");
  const after = site("2026-03-08T07:00:00Z");
  assert.match(await before("/team/when", NEW_YORK), /Mar 8, 1:59\sAM/);
  assert.match(await after("/team/when", NEW_YORK), /Mar 8, 3:00\sAM/);
  assert.match(await before("/team/when", KOLKATA), /Mar 8, 12:29\sPM/);
  assert.match(await after("/team/when", KOLKATA), /Mar 8, 12:30\sPM/);
});

test("a cookie that is not a zone name is ignored", async () => {
  const get = site("2026-06-15T14:30:00Z");
  for (const bad of ["Mars/Olympus", "%2B05:00", "-05:00", "", "x".repeat(70), "%3Cscript%3E"]) {
    assert.equal(await get("/team/zone", `tt_zone=${bad}`), "America/Chicago", bad);
    assert.match(await get("/team/when", `tt_zone=${bad}`), /9:30\sAM/, bad);
  }
});

test("only the team's pages follow the cookie, and a pinned time never does", async () => {
  const get = site("2026-06-15T14:30:00Z");
  assert.match(await get("/public", KOLKATA), /9:30\sAM/, "a customer's page is not the team's");
  assert.match(await get("/team/pinned", KOLKATA), /9:30\sAM/);
});

/** Runs the head's script against a stand-in browser. */
async function runScript(browser: { zone: string; cookie: string; blocked?: boolean }) {
  const app = new Hono();
  app.get("/", (c) => c.html(<ViewerZoneScript />));
  const js = (await (await app.request("/")).text()).replace(/^<script>|<\/script>$/g, "");
  const moved: string[] = [];
  const document = {
    get cookie() { return browser.cookie; },
    set cookie(v: string) { if (!browser.blocked) browser.cookie = v.split(";")[0]; },
  };
  runInNewContext(js, {
    document,
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: browser.zone }) }) },
    location: { protocol: "https:", href: "https://crm.example/", replace: (u: string) => moved.push(u) },
    encodeURIComponent,
  });
  return moved.length;
}

test("the script reloads once for a new zone, and never when the cookie will not stick", async () => {
  const browser = { zone: "Asia/Kolkata", cookie: "" };
  assert.equal(await runScript(browser), 1, "the first visit");
  assert.equal(browser.cookie, "tt_zone=Asia%2FKolkata");
  assert.equal(await runScript(browser), 0, "the reload stays");
  browser.zone = "America/New_York";
  assert.equal(await runScript(browser), 1, "off a plane");
  assert.equal(await runScript(browser), 0);
  assert.equal(await runScript({ zone: "Asia/Kolkata", cookie: "", blocked: true }), 0, "cookies off");
});

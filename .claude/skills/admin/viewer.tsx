// Whose clock a team page shows: the signed-in person's. A script in the head
// (ViewerZoneScript) keeps the browser's zone in a cookie; teamOnly hands that
// zone to everything the page renders, so <When> needs nothing passed to it.
// Off the team's pages, and with no cookie, the given zone stands.
//
//   viewerZone(c, business)   in a route: a day's bounds, a wall time typed in a form
//   shownZone(business)       in a component, while it renders
//
// Only what a person reads or types follows them. Emails, texts, scheduled
// work and a host's hours keep their own zones, which is why these take the
// zone to fall back on and nothing reads the cookie by itself. Edge-safe: an
// AsyncLocalStorage would be neater, but the Website's Worker has no Node APIs.
import type { Context } from "hono";
import { createContext, isValidElement, jsx, useContext } from "hono/jsx";
import { getCookie } from "hono/cookie";

const COOKIE = "tt_zone";
const Zone = createContext<string | null>(null);

// A name only: Intl takes "+05:00" as UTC+5, Postgres takes it as the opposite.
function named(zone: string | undefined): string | null {
  if (!zone || zone.length > 64 || !/^[A-Za-z]/.test(zone)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/** The zone this request's person is in, for code in a route. */
export const viewerZone = (c: Context, fallback: string): string => named(getCookie(c, COOKIE)) ?? fallback;

/** The zone this page is being shown in, for a component while it renders. */
export const shownZone = (fallback: string): string => useContext(Zone) ?? fallback;

/** Everything this request renders with c.html shows in the person's zone. */
export function showInViewerZone(c: Context): void {
  const zone = named(getCookie(c, COOKIE));
  if (!zone) return;
  const html = c.html;
  c.html = ((body: unknown, ...rest: unknown[]) =>
    (html as (...a: unknown[]) => unknown)(isValidElement(body) ? jsx(Zone.Provider, { value: zone }, body) : body, ...rest)) as typeof c.html;
}

// Reloads only once the cookie has really changed, so a blocked cookie, or a
// zone this server refuses, can never loop. Replace, not reload: a page that
// answered a POST is fetched again rather than sent twice.
const SCRIPT = `(function(){try{var z=Intl.DateTimeFormat().resolvedOptions().timeZone,k="${COOKIE}=",v=encodeURIComponent(z||""),has=function(){return (";"+document.cookie.replace(/; /g,";")+";").indexOf(";"+k+v+";")>=0};if(!z||has())return;document.cookie=k+v+"; path=/; max-age=31536000; samesite=lax"+(location.protocol==="https:"?"; secure":"");if(has())location.replace(location.href)}catch(e){}})()`;

/** In the head of a team page, before anything paints. */
export const ViewerZoneScript = () => <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;

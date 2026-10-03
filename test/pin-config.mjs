// The tests run against the config the CRM ships with, so a CRM the AI has
// shaped (other words, other stages) still passes its own suite. The live
// crm.config.json is only validated (config.test.ts).
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        const r = await next(specifier, context);
        return r.url.endsWith("/crm.config.json") && !r.url.includes("/test/fixtures/")
          ? { ...r, url: new URL("./test/fixtures/crm.config.json", ${JSON.stringify(new URL("../", import.meta.url).href)}).href }
          : r;
      }
    `),
);

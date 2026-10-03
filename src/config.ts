// crm.config.json, read once and validated. The first lever the AI pulls to
// shape the CRM: the words, the stages seeded on the first run, sources,
// custom fields, the business's time zone, what counts as a lead, what a
// visit is called. Nothing here changes a table name.
import config from "../crm.config.json";
import { validate, type Config } from "./config-schema";

export * from "./config-schema";

const problems = validate(config);
if (problems.length) {
  throw new Error("crm.config.json is not valid:\n  - " + problems.join("\n  - "));
}

export const cfg = config as Config;
export const vocab = cfg.vocabulary;
export const ownerLabel = cfg.owner_label ?? "Owner";
export const showPipeline = cfg.pipeline !== false;
/** Jobs, visits, appointments or events, or null when the config turns them off. */
export const visitsCfg = cfg.visits ? { ...cfg.visits, currency: cfg.visits.currency ?? "USD" } : null;

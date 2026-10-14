// crm.config.json, read once and validated. The first lever the AI pulls to
// shape the CRM: the words, the statuses and deal stages seeded on the first run, sources,
// custom fields, the business's time zone, what counts as a lead, what an
// event is called. Nothing here changes a table name.
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
/** Deals: their words, stages seeded on the first run, currency, reasons offered when one is lost. */
export const dealsCfg = { ...cfg.deals, currency: cfg.deals.currency ?? "USD", lost_reasons: cfg.deals.lost_reasons ?? [] };
/** A lead added from the Inbox gets a "Call back" task due that day. */
export const newLeadTask = cfg.tasks?.new_lead !== false;
/** What the first run seeds. */
export const seeds = { statuses: cfg.statuses, dealStages: cfg.deals.stages, fields: cfg.fields };
/** The schedule's events (their words, fields and currency), or null when the config turns the schedule off. */
export const eventsCfg = cfg.events ? { ...cfg.events, currency: cfg.events.currency ?? "USD" } : null;
/** Online booking: the Services customers book. Only with the schedule on. */
export const showBooking = !!eventsCfg && cfg.booking !== false;
/** Quotes and invoices, or null when the config turns them off. The name is blank until the business has given it. */
export const invoicesCfg = cfg.invoices
  ? { ...cfg.invoices, name: cfg.invoices.name === "to fill" ? "" : cfg.invoices.name.trim(), currency: (cfg.invoices.currency ?? eventsCfg?.currency ?? "USD").toLowerCase() }
  : null;

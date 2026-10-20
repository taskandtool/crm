-- The data skill's tables: what every app in the project shares about the
-- business itself, and the email opt-outs every app's follow-up emails
-- keep. Additive only (migrate.ts). Applied before any other skill's tables.

-- The business, once for the whole project: the name texts sign with,
-- quotes print and the texting box names, the privacy and terms pages the
-- texting box links, and the postal address a follow-up email ends with.
-- One row; set in the CRM's Settings, Business.
create table if not exists business (
  id               boolean primary key default true check (id),
  name             text,
  privacy_url      text,
  terms_url        text,
  updated_by       citext,
  updated_at       timestamptz not null default now()
);
alter table business add column if not exists address text;

-- The follow-up emails a person unsubscribed from (the ones CAN-SPAM counts
-- as commercial), and the keys their emails' unsubscribe links carry
-- (hashed; the key is only in the email).
create table if not exists email_optouts (
  email            citext primary key,
  at               timestamptz not null default now()
);
create table if not exists unsubscribe_keys (
  hash             text primary key,
  email            citext not null,
  created_at       timestamptz not null default now()
);

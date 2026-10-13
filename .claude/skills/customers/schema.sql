-- The project's customers and their notes: one set of rows every app reads.
-- A note the team logs on a submission (the forms inbox) is on that
-- customer's timeline in the CRM, and one logged in the CRM shows on the
-- submission. Whichever app runs first makes the tables; the other's run
-- then changes nothing. Additive only (data/SKILL.md).

create table if not exists customers (
  id               bigserial primary key,
  name             text not null,
  email            citext,
  phone            text,
  company          text,
  address          text,
  stage            text not null,
  source           text,
  tags             text[] not null default '{}',
  owner            citext,
  fields           jsonb not null default '{}'::jsonb check (jsonb_typeof(fields) = 'object'),
  notes            text,
  last_contact_at  timestamptz,
  archived_at      timestamptz,
  created_by       citext,
  updated_by       citext,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Email is unique when present; a customer may have only a phone.
create unique index if not exists customers_email on customers (email) where email is not null;
create index if not exists customers_updated on customers (updated_at desc, id desc);
create index if not exists customers_stage_updated on customers (stage, updated_at desc, id desc);
create index if not exists customers_owner on customers (owner);
create index if not exists customers_tags on customers using gin (tags);
create index if not exists customers_name_trgm on customers using gin (name gin_trgm_ops);
create index if not exists customers_email_trgm on customers using gin ((email::text) gin_trgm_ops);
create index if not exists customers_phone_trgm on customers using gin (phone gin_trgm_ops);
create index if not exists customers_company_trgm on customers using gin (company gin_trgm_ops);
-- The phone match key: its last ten digits, an extension left off
-- (the CRM's src/crm/phone.ts says why). customers_phone_key is the first version's,
-- kept because this file only adds.
create index if not exists customers_phone_key on customers ((right(regexp_replace(phone, '[^0-9]', '', 'g'), 10)));
create index if not exists customers_phone_match on customers ((right(regexp_replace(regexp_replace(phone, '[[:space:]]*(ext|extension|x|#)[.:[:space:]]*[0-9]+[[:space:]]*$', '', 'i'), '[^0-9]', '', 'g'), 10)));

create table if not exists customer_notes (
  id           bigserial primary key,
  customer_id  bigint not null references customers (id) on delete cascade,
  kind         text not null default 'note' check (kind in ('note', 'call', 'email', 'meeting', 'text')),
  body         text not null,
  author       citext,
  happened_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists customer_notes_customer on customer_notes (customer_id, happened_at desc, id desc);

-- Merging: the addresses a customer also goes by (the merged record's,
-- lower case, as data/email.ts stores every address; text[] because pg reads
-- a citext[] back as a string), so
-- what the project's other tables hold under those addresses is still theirs,
-- and on the merged record, the one it went into.
alter table customers add column if not exists other_emails text[] not null default '{}';
alter table customers add column if not exists merged_into bigint;
create index if not exists customers_other_emails on customers using gin (other_emails);
-- The CRM list's order: most recent contact first, one never contacted by when they were added.
create index if not exists customers_contact_order on customers ((coalesce(last_contact_at, created_at)) desc, id desc);

comment on table customers is 'One row per customer, keyed by email when there is one (unique, case-blind). fields holds the custom fields crm.config.json declares. Archived, never deleted, from the CRM.';
comment on column customers.owner is 'Who looks after this customer: usually a team member''s email.';
comment on column customers.last_contact_at is 'The latest call, email, meeting or text noted, or when the person first got in touch.';
comment on table customer_notes is 'A customer''s timeline: notes, calls, emails, meetings and texts, with who wrote them and when they happened.';
comment on column customers.other_emails is 'Other addresses this customer goes by, from a merge: matched everywhere their email is.';
comment on column customers.merged_into is 'The customer this record was merged into; set on the archived duplicate.';

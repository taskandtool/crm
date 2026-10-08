-- The CRM's tables. Applied with applySchema (src/data/migrate.ts) every time
-- the service starts and before every deploy, by every copy of this app, so
-- it only ever adds: create table if not exists, create index if not exists,
-- alter table add column if not exists, comment on. Never drop, rename or
-- retype; a new column gets its own `alter table ... add column if not
-- exists` line below as well as a place in the create.
-- No semicolons inside a statement and no double hyphens inside a string:
-- applySchema splits on the one and strips the other.
--
-- These are the project's tables, read by every app in it: Booking and the
-- Board show a customer's name from `customers`. A person is their email.

create table if not exists pipeline_stages (
  key         text primary key check (key ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  label       text not null,
  position    integer not null default 0,
  kind        text not null default 'open' check (kind in ('open', 'won', 'lost')),
  archived    boolean not null default false,
  updated_by  citext,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

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
-- (src/crm/phone.ts says why). customers_phone_key is the first version's,
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

-- One job, visit, appointment or event for a customer: what it was, when,
-- who did it, whether it happened, what it cost. crm.config.json's `visits`
-- names it for the business and declares its own custom fields.
create table if not exists customer_visits (
  id            bigserial primary key,
  customer_id   bigint not null references customers (id) on delete cascade,
  title         text not null,
  status        text not null default 'planned' check (status in ('planned', 'done', 'cancelled')),
  starts_at     timestamptz,
  owner         citext,
  amount_cents  bigint check (amount_cents >= 0),
  currency      text,
  fields        jsonb not null default '{}'::jsonb check (jsonb_typeof(fields) = 'object'),
  notes         text,
  created_by    citext,
  updated_by    citext,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists customer_visits_customer on customer_visits (customer_id, starts_at desc nulls first, id desc);
create index if not exists customer_visits_when on customer_visits ((coalesce(starts_at, created_at)), id);
create index if not exists customer_visits_status_when on customer_visits (status, (coalesce(starts_at, created_at)), id);

-- A job made from a booking ("Make it a job") names it, once. No foreign
-- key: a CRM with booking off has no bookings table.
alter table customer_visits add column if not exists booking_id bigint;
create unique index if not exists customer_visits_booking on customer_visits (booking_id) where booking_id is not null;

comment on table pipeline_stages is 'A customer''s statuses (Lead, Customer, Not a fit), one row each, edited by the owner. customers.stage holds a key. Seeded once from crm.config.json statuses.';
comment on table customers is 'One row per customer, keyed by email when there is one (unique, case-blind). fields holds the custom fields crm.config.json declares. Archived, never deleted, from the CRM.';
comment on column customers.owner is 'Who looks after this customer: usually a team member''s email.';
comment on column customers.last_contact_at is 'The latest call, email, meeting or text noted, or when the person first got in touch.';
comment on table customer_notes is 'A customer''s timeline: notes, calls, emails, meetings and texts, with who wrote them and when they happened.';
comment on table customer_visits is 'A customer''s jobs, visits, appointments or events (crm.config.json names them): planned, done or cancelled, never deleted. fields holds the custom fields the config declares for them.';
comment on column customer_visits.booking_id is 'The booking this was made from, if any (the booking skill''s bookings.id).';
comment on column customer_visits.starts_at is 'When it happens or happened; null while it is not scheduled yet.';
comment on column customer_visits.amount_cents is 'What it was worth, in the minor units of currency (cents for USD). A record, not a payment: payments are their own table.';

-- Deals: one piece of work the team is trying to win, for one customer, in
-- the deal pipeline. A customer has as many as they bring over the years.
-- deal_stages is the deal pipeline as rows, the same shape as
-- pipeline_stages (which holds the customers' statuses); crm.config.json's
-- deals.stages seeds it once.
create table if not exists deal_stages (
  key         text primary key check (key ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  label       text not null,
  position    integer not null default 0,
  kind        text not null default 'open' check (kind in ('open', 'won', 'lost')),
  archived    boolean not null default false,
  updated_by  citext,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists deals (
  id                bigserial primary key,
  customer_id       bigint not null references customers (id) on delete cascade,
  title             text not null,
  stage             text not null,
  stage_changed_at  timestamptz not null default now(),
  value_cents       bigint check (value_cents >= 0),
  currency          text,
  owner             citext,
  expected_close    date,
  closed_at         timestamptz,
  lost_reason       text,
  notes             text,
  archived_at       timestamptz,
  created_by        citext,
  updated_by        citext,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists deals_customer on deals (customer_id, created_at desc, id desc);
create index if not exists deals_stage_updated on deals (stage, updated_at desc, id desc);
create index if not exists deals_closed on deals (closed_at) where closed_at is not null;

-- Follow-ups: the next thing to do for a customer (and the deal it is for),
-- due on a day in the business's zone, at a time or any time that day,
-- by one person. Ticked off, never deleted.
create table if not exists follow_ups (
  id           bigserial primary key,
  customer_id  bigint not null references customers (id) on delete cascade,
  deal_id      bigint references deals (id) on delete set null,
  kind         text not null default 'call' check (kind in ('call', 'email', 'meeting', 'text', 'task')),
  title        text not null,
  due_on       date not null,
  due_time     time,
  owner        citext,
  done_at      timestamptz,
  done_by      citext,
  created_by   citext,
  updated_by   citext,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists follow_ups_open on follow_ups (due_on, due_time, id) where done_at is null;
create index if not exists follow_ups_customer_open on follow_ups (customer_id, due_on) where done_at is null;
create index if not exists follow_ups_owner_open on follow_ups (owner, due_on) where done_at is null;

-- The morning email, claimed once per person per day before it is sent, so
-- two runs never send it twice and a failed send is not retried into a flood.
create table if not exists follow_up_digests (
  email       citext not null,
  day         date not null,
  status      text not null default 'claimed' check (status in ('claimed', 'sent', 'none', 'failed')),
  detail      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (email, day)
);

-- A job made from a won deal names it.
alter table customer_visits add column if not exists deal_id bigint;
create index if not exists customer_visits_deal on customer_visits (deal_id) where deal_id is not null;

-- Merging: the addresses a customer also goes by (the merged record's,
-- lower case, as data/email.ts stores every address; text[] because pg reads
-- a citext[] back as a string), so
-- what the project's other tables hold under those addresses is still theirs,
-- and on the merged record, the one it went into.
alter table customers add column if not exists other_emails text[] not null default '{}';
alter table customers add column if not exists merged_into bigint;
create index if not exists customers_other_emails on customers using gin (other_emails);

comment on table deal_stages is 'The deal pipeline, one row per stage, edited by the owner. deals.stage holds a key. Seeded once from crm.config.json deals.stages.';
comment on table deals is 'Work the team is trying to win, one customer each: its stage, value, owner and expected close. Won or lost stages set closed_at. Archived, never deleted.';
comment on column deals.value_cents is 'What it is worth, in minor units of currency. Blank: the latest quote made for it stands in.';
comment on column deals.stage_changed_at is 'When the stage last moved: a quote accepted after it wins the deal; one accepted before does not undo a later move.';
comment on table follow_ups is 'The next things to do for a customer: a call, email, meeting, text or task due on a day (in the business''s zone), by one person. Done ones keep done_at and done_by.';
comment on table follow_up_digests is 'The morning email of due follow-ups, claimed once per person per day.';
comment on column customers.other_emails is 'Other addresses this customer goes by, from a merge: matched everywhere their email is.';
comment on column customers.merged_into is 'The customer this record was merged into; set on the archived duplicate.';

-- What the scripts last set up, so a script call skips setup when nothing
-- changed: one row, the hash of the schema files setup applied.
create table if not exists crm_setup (
  name text primary key,
  schema_hash text not null,
  updated_at timestamptz not null default now()
);
comment on table crm_setup is 'The hash of the schema the CRM''s setup last applied; the command-line scripts skip setup while it matches.';

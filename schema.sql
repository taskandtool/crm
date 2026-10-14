-- The CRM's tables. Applied with applySchema (src/data/migrate.ts) every time
-- the service starts and before every deploy, by every copy of this app, so
-- it only ever adds: create table if not exists, create index if not exists,
-- alter table add column if not exists, comment on. Never drop, rename or
-- retype; a new column gets its own `alter table ... add column if not
-- exists` line below as well as a place in the create.
-- No semicolons inside a statement and no double hyphens inside a string:
-- applySchema splits on the one and strips the other.

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

-- The customers and their notes are the customers skill's tables
-- (src/customers/schema.sql), which setup applies before this file; the
-- Website's submission pages read and note the same rows.

-- The schedule's events live in the booking skill's `bookings` (one
-- appointment table, whoever made it). What the CRM adds to each: the
-- customer it is for (an online booking is matched by its email, else phone),
-- what it was worth, and the business's own fields. Setup applies the
-- booking skill's schema first, always, so the table is there.
alter table bookings add column if not exists customer_id bigint;
alter table bookings add column if not exists amount_cents bigint check (amount_cents >= 0);
alter table bookings add column if not exists currency text;
alter table bookings add column if not exists fields jsonb not null default '{}'::jsonb check (jsonb_typeof(fields) = 'object');
create index if not exists bookings_customer on bookings (customer_id, starts_at desc) where customer_id is not null;
-- The deal an event is for (a visit to quote the work, the job itself), one
-- of its customer's: a deal's page lists them, as Pipedrive's activities on a deal.
alter table bookings add column if not exists deal_id bigint;
create index if not exists bookings_deal on bookings (deal_id, starts_at desc) where deal_id is not null;

comment on table pipeline_stages is 'A customer''s statuses (Lead, Customer, Not a fit), one row each, edited by the owner. customers.stage holds a key. Seeded once from crm.config.json statuses.';

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

-- Tasks: the next thing to do for a customer (and the deal it is for),
-- due on a day in the business's zone, at a time or any time that day,
-- by one person. Ticked off, never deleted. The tables keep the name they
-- were made with (follow_ups), as tables are never renamed.
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

comment on table deal_stages is 'The deal pipeline, one row per stage, edited by the owner. deals.stage holds a key. Seeded once from crm.config.json deals.stages.';
comment on table deals is 'Work the team is trying to win, one customer each: its stage, value, owner and expected close. Won or lost stages set closed_at. Archived, never deleted.';
comment on column deals.value_cents is 'What it is worth, in minor units of currency. Blank: the latest quote made for it stands in.';
comment on column deals.stage_changed_at is 'When the stage last moved: a quote accepted after it wins the deal; one accepted before does not undo a later move.';
comment on table follow_ups is 'Tasks: the next things to do for a customer: a call, email, meeting, text or to-do due on a day (in the business''s zone), by one person. Done ones keep done_at and done_by.';
comment on table follow_up_digests is 'The morning email of due tasks, claimed once per person per day.';

-- What the scripts last set up, so a script call skips setup when nothing
-- changed: one row, the hash of the schema files setup applied.
create table if not exists crm_setup (
  name text primary key,
  schema_hash text not null,
  updated_at timestamptz not null default now()
);
comment on table crm_setup is 'The hash of the schema the CRM''s setup last applied; the command-line scripts skip setup while it matches.';

-- The bell (crm/notifications.ts): when each person last opened it.
-- Unread is anything newer; no row is everything.
create table if not exists notifications_seen (
  email citext primary key,
  seen_at timestamptz not null default now()
);
comment on table notifications_seen is 'When each team member last opened the bell: unread is anything newer.';

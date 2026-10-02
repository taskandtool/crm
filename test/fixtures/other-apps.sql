-- Test fixture: the forms, booking and payments skills' schema.sql (taskandtool/skills 0.1.0),
-- concatenated, so the CRM's tests read the same tables a project has. Not applied by the app.

-- forms: every form in the project is a row, and every submission from any
-- app lands in one table the CRM reads. Additive only (data/SKILL.md).
-- No semicolons inside a statement and no double hyphens inside a string:
-- applySchema splits on the one and strips the other.

create table if not exists forms (
  id              bigserial primary key,
  key             text not null unique check (key ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  title           text not null,
  fields          jsonb not null default '[]'::jsonb check (jsonb_typeof(fields) = 'array'),
  notify_emails   citext[] not null default '{}',
  redirect_to     text,
  success_message text,
  submit_label    text,
  active          boolean not null default true,
  source          text,
  updated_by      citext,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists submissions (
  id          bigserial primary key,
  form_key    text not null,
  name        text,
  email       citext,
  phone       text,
  data        jsonb not null default '{}'::jsonb,
  source      text not null,
  page        text,
  status      text not null default 'new' check (status in ('new', 'read', 'done', 'spam')),
  updated_by  citext,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists submissions_form_recent on submissions (form_key, created_at desc, id desc);
create index if not exists submissions_recent on submissions (created_at desc, id desc);
create index if not exists submissions_email on submissions (email);
create index if not exists submissions_status on submissions (status, created_at desc, id desc);
create index if not exists submissions_name_trgm on submissions using gin (name gin_trgm_ops);
create index if not exists submissions_email_trgm on submissions using gin ((email::text) gin_trgm_ops);

comment on table forms is 'One row per form. fields is the ordered definition the renderer and validator read (forms skill).';
comment on table submissions is 'Every form submission from every app in the project. A person is their email. No IP addresses are stored.';
comment on column submissions.data is 'Every answer that is not name, email or phone, keyed by field name. _consent holds the wording of each consent box ticked; _utm (source, medium, campaign) and _referrer (a host) say where the visitor came from.';

-- booking: who can be booked, when, and what is booked. Additive only
-- (data/SKILL.md): run with applySchema from setup or start.
--
-- Times a person chose are instants (timestamptz) with the IANA zone stored
-- beside them. Weekly hours are wall times (time) in the resource's zone.
-- Weekday is 0 Sunday to 6 Saturday, as extract(dow) and Date#getUTCDay.

create table if not exists resources (
  id bigserial primary key,
  kind text not null default 'person' check (kind in ('person', 'crew')),
  slug text,
  name text not null,
  email citext,
  time_zone text not null,
  duration_min integer not null default 30 check (duration_min between 5 and 1440),
  interval_min integer not null default 30 check (interval_min between 5 and 1440),
  buffer_before_min integer not null default 0 check (buffer_before_min between 0 and 1440),
  buffer_after_min integer not null default 0 check (buffer_after_min between 0 and 1440),
  min_notice_min integer not null default 120 check (min_notice_min between 0 and 525600),
  horizon_days integer not null default 60 check (horizon_days between 0 and 730),
  active boolean not null default true,
  source text,
  updated_by citext,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists resources_slug on resources (slug);
create index if not exists resources_email on resources (email);

-- A crew is booked as one; each booking goes to one free member.
create table if not exists resource_members (
  crew_id bigint not null references resources (id) on delete cascade,
  member_id bigint not null references resources (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (crew_id, member_id),
  check (crew_id <> member_id)
);

-- Weekly hours. end_local may be 24:00 (until midnight); a window never
-- crosses midnight: split it into two rows on two weekdays.
create table if not exists availability (
  id bigserial primary key,
  resource_id bigint not null references resources (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_local time not null,
  end_local time not null,
  updated_by citext,
  created_at timestamptz not null default now(),
  check (start_local < end_local)
);
create index if not exists availability_resource on availability (resource_id, weekday);

create table if not exists time_off (
  id bigserial primary key,
  resource_id bigint not null references resources (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  note text,
  updated_by citext,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists time_off_resource_end on time_off (resource_id, ends_at);

-- A calendar the owner connected for a resource. external_id is the
-- provider's calendar id (primary means the account's main calendar).
-- receives_bookings: the sync job writes bookings into the first such one.
create table if not exists calendars (
  id bigserial primary key,
  resource_id bigint not null references resources (id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  external_id text not null default 'primary',
  receives_bookings boolean not null default true,
  last_synced_at timestamptz,
  last_error text,
  updated_by citext,
  created_at timestamptz not null default now()
);
create unique index if not exists calendars_resource_provider_external on calendars (resource_id, provider, external_id);

-- Busy times copied from a calendar by the sync job; it replaces a
-- calendar's rows on every run. Pages read only this, never the calendar.
create table if not exists busy (
  id bigserial primary key,
  calendar_id bigint not null references calendars (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  check (ends_at > starts_at)
);
create index if not exists busy_calendar_end on busy (calendar_id, ends_at);

create table if not exists bookings (
  id bigserial primary key,
  resource_id bigint not null references resources (id),
  crew_id bigint references resources (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  name text not null,
  email citext not null,
  phone text,
  booker_time_zone text,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled', 'completed', 'no_show')),
  answers jsonb not null default '{}'::jsonb,
  manage_token_hash text,
  external_event_id text,
  external_provider text,
  external_calendar_id bigint,
  external_error text,
  synced_sequence integer,
  push_claimed_at timestamptz,
  source text,
  sequence integer not null default 0,
  cancelled_at timestamptz,
  updated_by citext,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists bookings_resource_end on bookings (resource_id, ends_at);
create index if not exists bookings_starts on bookings (starts_at, id);
create index if not exists bookings_email on bookings (email);
create unique index if not exists bookings_manage_token on bookings (manage_token_hash);

comment on column bookings.sequence is 'Rises on every reschedule and cancel. It is the ICS SEQUENCE, and the sync job compares it with synced_sequence.';
comment on column bookings.manage_token_hash is 'Hex SHA-256 of the manage link token. The token itself is never stored.';

-- Our name for the booking's calendar event, chosen before the event exists,
-- so a create the job retries finds the event it already made instead of
-- making a second one, and the pull knows our events by it (sync.ts). The
-- default fills every row, old ones included, whichever app inserts: 32 hex
-- characters, which Google's event ids (base32hex) accept as they are.
alter table bookings add column if not exists event_key text default replace(gen_random_uuid()::text, '-', '');
comment on column bookings.event_key is 'Random, never changes. sync.ts derives each calendar event''s id or tag from it.';

-- payments: what was charged through the owner's Stripe account, and the
-- Stripe events already handled. Additive only (data/SKILL.md).

create table if not exists payments (
  id bigserial primary key,
  email citext,                                   -- normalizeEmail; filled from Checkout when the payer typed it there
  name text,
  amount_cents bigint not null check (amount_cents >= 0),   -- minor units of `currency` (yen are whole yen)
  currency text not null check (currency ~ '^[a-z]{3}$'),
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'cancelled')),
  kind text not null default 'full' check (kind in ('deposit', 'full', 'invoice', 'other')),
  ref_type text,                                  -- what it pays for: 'booking', 'invoice', ...
  ref_id text,
  description text,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  refunded_cents bigint not null default 0 check (refunded_cents >= 0),
  livemode boolean,                               -- false for a test-mode key; keep test rows out of revenue
  source text,
  updated_by citext,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  match_key text                                  -- random, sent as metadata[payment_key]: an event from another project on the same Stripe account never matches this row
);

alter table payments add column if not exists match_key text;

create index if not exists payments_ref on payments (ref_type, ref_id);
create index if not exists payments_email on payments (email);
create index if not exists payments_recent on payments (created_at desc, id desc);
create unique index if not exists payments_intent on payments (stripe_payment_intent_id);
create index if not exists payments_email_trgm on payments using gin ((email::text) gin_trgm_ops);
create index if not exists payments_name_trgm on payments using gin (name gin_trgm_ops);

comment on table payments is 'Payments through the owner''s Stripe account. Status changes only from verified Stripe webhooks (payments skill).';

create table if not exists stripe_events (
  id text primary key,                            -- Stripe's event id (evt_...): one row per event ever handled
  type text not null,
  received_at timestamptz not null default now(),
  payment_id bigint
);

create index if not exists stripe_events_payment on stripe_events (payment_id);

comment on table stripe_events is 'Stripe events already handled, by event id, so a redelivery is a no-op for every app on the project.';

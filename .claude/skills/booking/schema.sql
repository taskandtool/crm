-- booking: what can be booked, who takes it, when, and what is booked. Additive only
-- (data/SKILL.md): run with applySchema from setup or start.
--
-- Times a person chose are instants (timestamptz) with the IANA zone stored
-- beside them. Weekly hours are wall times (time) in the resource's zone.
-- Weekday is 0 Sunday to 6 Saturday, as extract(dow) and Date#getUTCDay.

-- The people who can be booked. A booking type (below) says what is booked
-- and which of them can take it; their own hours, time off and calendars
-- say when.
create table if not exists resources (
  id bigserial primary key,
  name text not null,
  email citext,
  time_zone text not null,
  active boolean not null default true,
  source text,
  updated_by citext,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists resources_email on resources (email);

-- What a customer books: an installation, a sales visit, a video call. Its
-- slug is its public address (/book/<slug>). Where it happens:
--   their_place  at the customer's address, which they give when booking
--   our_place    at `location`, the business's address
--   phone        the business calls the number they give
--   video        at `location`, the owner's own meeting link
create table if not exists booking_types (
  id bigserial primary key,
  slug text not null check (slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$' and slug <> 'manage'),
  name text not null,
  description text,
  duration_min integer not null default 30 check (duration_min between 5 and 1440),
  interval_min integer not null default 30 check (interval_min between 5 and 1440),
  buffer_before_min integer not null default 0 check (buffer_before_min between 0 and 1440),
  buffer_after_min integer not null default 0 check (buffer_after_min between 0 and 1440),
  min_notice_min integer not null default 120 check (min_notice_min between 0 and 525600),
  horizon_days integer not null default 60 check (horizon_days between 0 and 730),
  location_kind text not null default 'our_place' check (location_kind in ('their_place', 'our_place', 'phone', 'video')),
  location text,
  position integer not null default 0,
  active boolean not null default true,
  source text,
  updated_by citext,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists booking_types_slug on booking_types (slug);

-- Who can take a type. With several, the booker picks one or takes the
-- first free; each booking goes to one person.
create table if not exists booking_type_hosts (
  type_id bigint not null references booking_types (id) on delete cascade,
  resource_id bigint not null references resources (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (type_id, resource_id)
);
create index if not exists booking_type_hosts_resource on booking_type_hosts (resource_id);

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
  type_id bigint not null references booking_types (id),
  resource_id bigint not null references resources (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  name text not null,
  email citext not null,
  phone text,
  location_kind text not null check (location_kind in ('their_place', 'our_place', 'phone', 'video')),
  location text,
  booker_time_zone text,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled', 'completed', 'no_show')),
  answers jsonb not null default '{}'::jsonb,
  manage_token_hash text,
  external_event_id text,
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
create index if not exists bookings_type on bookings (type_id, starts_at);
create unique index if not exists bookings_manage_token on bookings (manage_token_hash);

comment on column bookings.resource_id is 'The person taking it.';
comment on column bookings.location is 'Where, as it was when booked: the customer''s address, the business''s address, the number to call, or the meeting link.';
comment on column bookings.sequence is 'Rises on every reschedule and cancel. It is the ICS SEQUENCE, and the sync job compares it with synced_sequence.';
comment on column bookings.manage_token_hash is 'Hex SHA-256 of the manage link token. The token itself is never stored.';

-- Our name for the booking's calendar event, chosen before the event exists,
-- so a create the job retries finds the event it already made instead of
-- making a second one, and the pull knows our events by it (sync.ts). The
-- default fills every row, old ones included, whichever app inserts: 32 hex
-- characters, which Google's event ids (base32hex) accept as they are.
alter table bookings add column if not exists event_key text default replace(gen_random_uuid()::text, '-', '');
comment on column bookings.event_key is 'Random, never changes. sync.ts derives each calendar event''s id or tag from it.';

-- Reminders the job (reminders-job.ts) claimed, one row each: a reminder is for a
-- booking at one start time, so a booking that moves is reminded again, and a
-- claimed row is never sent twice. status: sent, none (no sender connected),
-- failed (detail says why), sending (claimed by a run that died).
create table if not exists booking_reminders (
  booking_id bigint not null references bookings (id) on delete cascade,
  before_min integer not null check (before_min between 1 and 10080),
  starts_at timestamptz not null,
  status text not null default 'sending' check (status in ('sending', 'sent', 'none', 'failed')),
  detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (booking_id, before_min, starts_at)
);

-- Paid booking types and bookings made by a form (the forms skill's booking
-- step). A type's price is what a payment step charges for it. A booking
-- made in a form holds its time until hold_until; one whose form is not
-- complete (or being paid) by then is released (book.ts releaseLapsedHolds).
alter table booking_types add column if not exists price_cents bigint check (price_cents >= 0);
alter table booking_types add column if not exists currency text check (currency ~ '^[a-z]{3}$');
alter table bookings add column if not exists submission_id bigint;
alter table bookings add column if not exists hold_until timestamptz;
create index if not exists bookings_submission on bookings (submission_id);
create index if not exists bookings_hold on bookings (hold_until) where hold_until is not null;
comment on column bookings.submission_id is 'The form submission that made it (forms skill), when a form did.';
comment on column bookings.hold_until is 'Held for the rest of its form until then; released if the form is not complete or being paid by then.';
-- A booking made in a form is confirmed when the form is complete
-- (confirm.ts), once, by whichever app gets there first with a sender.
alter table bookings add column if not exists confirmation_sent_at timestamptz;
comment on column bookings.confirmation_sent_at is 'When the confirmation of a booking made in a form was sent, on the form completing. Null for a booking made any other way: its page confirms it at once.';

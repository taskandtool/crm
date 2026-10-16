-- The phone skill's tables: the business's numbers, every text and call on
-- them, the automatic texts' changes and sends, and the links those texts
-- carry. Additive only (data/migrate.ts). Applied after the customers,
-- booking and forms skills' tables, whose columns it adds to.

-- A number the business owns on its own Twilio account. The first is the
-- business number; more can be added for a van or an ad, each with a label,
-- and every call and text says which it came in on. `ring_to` is the phone
-- a call rings (E.164); `texting` is where the US texting registration
-- stands, `registration` its Twilio ids and statuses as last read.
-- `hooks_url` is the app's inbound address for Twilio (no secret in it);
-- `hook_secret_hash` the hash of the basic-auth secret the number's call
-- and text addresses carry (hooks.ts).
create table if not exists phone_numbers (
  id               bigserial primary key,
  e164             text not null unique,
  label            text not null default 'Business number',
  provider         text not null default 'twilio',
  provider_id      text not null,
  ring_to          text,
  ring_seconds     integer not null default 20 check (ring_seconds between 5 and 60),
  voicemail        boolean not null default true,
  record_calls     boolean not null default false,
  texting          text not null default 'none' check (texting in ('none', 'pending', 'approved', 'failed')),
  registration     jsonb not null default '{}'::jsonb,
  hook_secret_hash text not null,
  hooks_url        text,
  created_by       citext,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Every text and call, in and out: one table, as GoHighLevel keeps them, so
-- a thread (the rows for one remote number) and a contact's history are one
-- query. `remote_key` is the remote number's last ten digits (the customers
-- skill's phoneKey). `contact_id` is whose it is, set on arrival when one
-- contact has the number and by a person when several do. `read_at` is
-- when someone opened what came in. An inbound STOP, START or HELP is kept
-- in `keyword`; a number has opted out when its latest STOP is newer than
-- its latest START. `sent_by` is a person's email, `flow:<key>`, or `ai`.
-- A call: `status` is Twilio's (completed, no-answer, busy, failed,
-- canceled), `answered_by` who pressed 1, with its voicemail or recording.
create table if not exists communications (
  id               bigserial primary key,
  phone_number_id  bigint references phone_numbers (id) on delete set null,
  local_e164       text not null,
  remote_e164      text not null,
  remote_key       text not null,
  contact_id       bigint references customers (id) on delete set null,
  kind             text not null check (kind in ('text', 'call')),
  direction        text not null check (direction in ('in', 'out')),
  status           text not null,
  body             text,
  media            jsonb not null default '[]'::jsonb,
  keyword          text check (keyword in ('stop', 'start', 'help')),
  sent_by          text,
  duration_s       integer,
  answered_by      text,
  voicemail_sid    text,
  voicemail_s      integer,
  transcript       text,
  recording_sid    text,
  error            text,
  provider         text not null default 'twilio',
  provider_id      text,
  read_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists communications_provider on communications (provider, provider_id) where provider_id is not null;
create index if not exists communications_thread on communications (remote_key, created_at desc, id desc);
create index if not exists communications_contact on communications (contact_id, created_at desc) where contact_id is not null;
create index if not exists communications_unread on communications (created_at desc) where direction = 'in' and read_at is null;

-- The owner's changes to an automatic text (flows.ts holds ours): only the
-- rows that differ. `words` maps a variant to its wording; `timing` is the
-- flow's own choice (minutes). Deleting the row brings ours back.
create table if not exists text_flows (
  key              text primary key,
  enabled          boolean,
  words            jsonb not null default '{}'::jsonb,
  timing           integer,
  updated_by       text,
  updated_at       timestamptz not null default now()
);

-- One automatic text, claimed before it goes, so two runs never send it
-- twice: unique per flow, step and what it is about (a call, a draft, a
-- submission, a booking). `channel` is text or email. `due_at` is when it
-- may go (quiet hours move it); a row still `due` is waiting. `offer` is
-- the times a "Stopped before booking" text offered (a reply of 1, 2 or 3
-- books one); `link` a short link made when it was scheduled (a booking's
-- manage link exists only then).
create table if not exists text_sends (
  id               bigserial primary key,
  flow             text not null,
  step             integer not null default 1,
  subject_type     text not null,
  subject_id       text not null,
  remote_key       text,
  email            citext,
  channel          text not null default 'text' check (channel in ('text', 'email')),
  due_at           timestamptz not null default now(),
  status           text not null default 'due' check (status in ('due', 'sending', 'sent', 'skipped', 'failed')),
  why              text,
  offer            jsonb,
  link             text,
  communication_id bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists text_sends_once on text_sends (flow, step, subject_type, subject_id);
create index if not exists text_sends_due on text_sends (due_at) where status = 'due';
create index if not exists text_sends_number on text_sends (remote_key, created_at desc);

-- A link a text carries that knows who it is for: a booking page with their
-- name, phone and email filled in, joined to their lead. Only the hash is
-- kept; it lasts 30 days.
create table if not exists link_keys (
  hash             text primary key,
  kind             text not null check (kind in ('booking')),
  ref              text not null,
  data             jsonb not null default '{}'::jsonb,
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now()
);

-- A short link on the business's own address, so a text stays one text:
-- /t/<code> (the Website) or /q/t/<code> (the CRM) redirects to `url`, a
-- path on the same site. The code is 8 letters and is itself the key: who
-- holds it opens what it points to, as with the long link. It lasts 30 days.
create table if not exists short_links (
  code             text primary key,
  url              text not null,
  clicks           integer not null default 0,
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now()
);

-- When each person last had Messages open: the owner's cell is told of a
-- new text only when nobody has for ten minutes.
create table if not exists messages_seen (
  email            citext primary key,
  seen_at          timestamptz not null default now()
);

-- A contact the team should not text (as if they had said STOP).
alter table customers add column if not exists texts_off boolean not null default false;

-- When the owner, texting the number from their own cell, was last told where to reply (once an hour).
alter table phone_numbers add column if not exists owner_replied_at timestamptz;

-- When the owner last turned a flow on: what came before is never texted about.
alter table text_flows add column if not exists enabled_at timestamptz;

-- The follow-up emails a person unsubscribed from (the review request and the
-- nudge to finish booking, which CAN-SPAM counts as commercial), and the keys
-- their emails' unsubscribe links carry (hashed; the key is only in the email).
create table if not exists email_optouts (
  email            citext primary key,
  at               timestamptz not null default now()
);
create table if not exists unsubscribe_keys (
  hash             text primary key,
  email            citext not null,
  created_at       timestamptz not null default now()
);

-- What kind of line a number is, asked of Twilio Lookup once (about a cent)
-- before its first automatic text: a landline can't get one, so it gets the
-- email instead, and a missed call from one gets nothing.
create table if not exists phone_lines (
  remote_key       text primary key,
  line_type        text,
  checked_at       timestamptz not null default now()
);

-- Test fixture: the forms and payments skills' schema.sql (taskandtool/skills: forms 0.1.0,
-- payments 0.1.0), concatenated, so the CRM's tests read the same tables a project has. The
-- booking skill's tables are the CRM's own (setup always applies src/booking/schema.sql).

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

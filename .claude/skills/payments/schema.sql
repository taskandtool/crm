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

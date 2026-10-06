-- invoices: quotes the team sends, and invoices the owner's Stripe account
-- sends and collects. Additive only (data/SKILL.md): run with applySchema from
-- setup or start.
--
-- A document names its customer as given (email the key; name, phone and
-- address copied in, so a quote reads as it was sent). Money is minor units of
-- the document's currency. Totals are written only by quotes.ts and
-- invoices.ts, from the lines, in SQL. Nothing is ever deleted.

-- Lines carry the payments skill's tax_rates: apply its schema first.

create table if not exists quotes (
  id bigserial primary key,
  number text not null,                           -- Q-0001, from the id's sequence
  email citext not null,
  name text,
  phone text,
  address text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'declined', 'expired')),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  subtotal_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  total_cents bigint not null default 0,
  valid_until date,
  notes text,
  terms text,
  sent_at timestamptz,
  decided_at timestamptz,
  decided_by citext,
  visit_id bigint,                                -- the CRM job it is for; no foreign key, as customer_visits.booking_id
  source text,
  created_by citext,
  updated_by citext,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists quotes_number on quotes (number);
create index if not exists quotes_email on quotes (email, created_at desc);
create index if not exists quotes_visit on quotes (visit_id);
create index if not exists quotes_recent on quotes (created_at desc, id desc);

-- amount_cents is quantity x unit_cents, rounded; tax_cents the tax on it
-- (inside it when the rate is inclusive). Both are computed by the insert.
create table if not exists quote_lines (
  id bigserial primary key,
  quote_id bigint not null references quotes (id),
  position integer not null,
  description text not null,
  quantity numeric(12, 2) not null check (quantity > 0),
  unit_cents bigint not null check (unit_cents >= 0),
  tax_rate_id bigint references tax_rates (id),
  amount_cents bigint not null,
  tax_cents bigint not null default 0
);
create index if not exists quote_lines_quote on quote_lines (quote_id, position);

-- status is ours only while draft (no Stripe invoice yet); from then on it is
-- Stripe's, and only the webhook moves it (payments/webhook.ts).
create table if not exists invoices (
  id bigserial primary key,
  quote_id bigint,
  visit_id bigint,
  email citext not null,
  name text,
  phone text,
  address text,
  status text not null default 'draft' check (status in ('draft', 'open', 'paid', 'void', 'uncollectible')),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  subtotal_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  total_cents bigint not null default 0,
  days_until_due integer not null default 30 check (days_until_due between 0 and 365),
  due_date date,
  notes text,
  stripe_invoice_id text,
  stripe_customer_id text,
  number text,                                    -- Stripe's, once finalized
  hosted_url text,
  pdf_url text,
  livemode boolean,
  match_key text not null default replace(gen_random_uuid()::text, '-', ''),   -- sent as metadata[invoice_key]: another project on the same Stripe account never matches
  sent_at timestamptz,
  paid_at timestamptz,
  payment_failed_at timestamptz,                  -- the latest failed attempt (invoice.payment_failed); the invoice stays open
  source text,
  created_by citext,
  updated_by citext,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists invoices_stripe on invoices (stripe_invoice_id);
create index if not exists invoices_email on invoices (email, created_at desc);
create index if not exists invoices_quote on invoices (quote_id);
create index if not exists invoices_visit on invoices (visit_id);
create index if not exists invoices_recent on invoices (created_at desc, id desc);

create table if not exists invoice_lines (
  id bigserial primary key,
  invoice_id bigint not null references invoices (id),
  position integer not null,
  description text not null,
  quantity numeric(12, 2) not null check (quantity > 0),
  unit_cents bigint not null check (unit_cents >= 0),
  tax_rate_id bigint references tax_rates (id),
  amount_cents bigint not null,
  tax_cents bigint not null default 0
);
create index if not exists invoice_lines_invoice on invoice_lines (invoice_id, position);

-- One Stripe customer per email per mode, found or made once.
create table if not exists stripe_customers (
  email citext not null,
  livemode boolean not null,
  stripe_customer_id text not null,
  created_at timestamptz not null default now(),
  primary key (email, livemode)
);

comment on table quotes is 'Quotes the team sends through the owner''s own sender (invoices skill). Status moves forward only.';
comment on table invoices is 'Invoices made, sent and collected by the owner''s Stripe account (invoices skill). Past draft, status changes only from verified Stripe webhooks.';
comment on column invoices.status is 'draft until sent with Stripe; then Stripe''s, moved only by the webhook, never backwards.';

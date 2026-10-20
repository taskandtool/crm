-- invoices: quotes the team sends, and invoices the owner's Stripe account
-- sends and collects. Run with applySchema from setup or start.
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
  visit_id bigint,                                -- the appointment it is for (bookings.id); no foreign key, so no bookings table is needed
  source text,
  created_by citext,
  updated_by citext,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The CRM deal a quote is for, as visit_id names its appointment.
  deal_id bigint,
  -- When the customer first opened it, set by the app that serves its page (the CRM's proposal link).
  viewed_at timestamptz
);
create unique index if not exists quotes_number on quotes (number);
create index if not exists quotes_email on quotes (email, created_at desc);
create index if not exists quotes_visit on quotes (visit_id);
create index if not exists quotes_deal on quotes (deal_id) where deal_id is not null;
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
  updated_at timestamptz not null default now(),
  -- How a sent invoice is collected: Stripe emails it to be paid (email), or
  -- charges the customer's card on file (charge). Set when it is sent, so a
  -- send that stopped part way finishes the same way.
  collect text not null default 'email' check (collect in ('email', 'charge')),
  -- An invoice a recurring invoice made: which one, and the period (its date) it bills. One per period.
  recurring_id bigint,
  period_on date
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
  -- The card the CRM charges for this customer: their first saved card, or the one a person chose.
  default_card text,
  primary key (email, livemode)
);

create unique index if not exists invoices_period on invoices (recurring_id, period_on) where recurring_id is not null;

-- A recurring invoice: lines that become an ordinary invoice on each date,
-- every `every` weeks, months or years from `first_on` (its day is every
-- invoice's day; the 1st to the 28th for months and years, so no month is
-- short of it). `next_n` is the next period's number from 0 and `next_on`
-- its date. `mode` is what happens on the date: a draft for a person
-- (made `days_ahead` early), sent to be paid, or charged to the card on file
-- (emailed while there is none). `pending` waits for its quote's yes; the
-- job reads only `active` ones. Ends on `ends_on`, or after `ends_after`
-- invoices (`made`). Totals are summed from its lines, as a draft's are.
create table if not exists recurring_invoices (
  id bigserial primary key,
  email citext not null,
  name text,
  phone text,
  address text,
  title text not null,
  currency text not null check (currency ~ '^[a-z]{3}$'),
  subtotal_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  total_cents bigint not null default 0,
  unit text not null check (unit in ('week', 'month', 'year')),
  every integer not null default 1 check (every between 1 and 12),
  first_on date not null,
  next_n integer not null default 0,
  next_on date not null,
  ends_on date,
  ends_after integer check (ends_after between 1 and 1000),
  made integer not null default 0,
  mode text not null default 'send' check (mode in ('draft', 'send', 'charge')),
  days_ahead integer not null default 3 check (days_ahead between 0 and 14),
  days_until_due integer not null default 30 check (days_until_due between 0 and 365),
  notes text,
  note_for_team text,
  owner citext,
  status text not null default 'active' check (status in ('pending', 'active', 'paused', 'ended')),
  quote_id bigint,
  checked_at timestamptz,
  source text,
  created_by citext,
  updated_by citext,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recurring_invoices_due on recurring_invoices (next_on) where status = 'active';
create index if not exists recurring_invoices_email on recurring_invoices (email);
create index if not exists recurring_invoices_quote on recurring_invoices (quote_id) where quote_id is not null;

create table if not exists recurring_invoice_lines (
  id bigserial primary key,
  recurring_id bigint not null references recurring_invoices (id),
  position integer not null,
  description text not null,
  quantity numeric(12, 2) not null check (quantity > 0),
  unit_cents bigint not null check (unit_cents >= 0),
  tax_rate_id bigint references tax_rates (id),
  amount_cents bigint not null,
  tax_cents bigint not null default 0
);
create index if not exists recurring_invoice_lines_recurring on recurring_invoice_lines (recurring_id, position);

-- The cards saved on our Stripe customers (on a hosted invoice page, or in
-- Stripe's Dashboard), mirrored from Stripe's events and refreshed before a
-- charge. Brand, last four and expiry only: Stripe keeps the card.
create table if not exists stripe_cards (
  stripe_payment_method_id text primary key,
  stripe_customer_id text not null,
  livemode boolean not null,
  brand text,
  last4 text,
  exp_month integer,
  exp_year integer,
  attached_at timestamptz not null default now(),
  detached_at timestamptz
);
create index if not exists stripe_cards_customer on stripe_cards (stripe_customer_id) where detached_at is null;

comment on table quotes is 'Quotes the team sends through the owner''s own sender (invoices skill). Editable until accepted or declined. Status moves forward only.';
comment on table invoices is 'Invoices made, sent and collected by the owner''s Stripe account (invoices skill). Past draft, status changes only from verified Stripe webhooks.';
comment on column invoices.status is 'draft until sent with Stripe; then Stripe''s, moved only by the webhook, never backwards.';

comment on column quotes.visit_id is 'The appointment the quote is for (the booking skill''s bookings.id, the CRM''s event), if any. No foreign key.';
comment on column invoices.visit_id is 'The appointment the invoice bills (the booking skill''s bookings.id, the CRM''s event), if any. No foreign key.';

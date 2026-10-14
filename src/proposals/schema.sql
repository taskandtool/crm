-- Proposals: a quote (the invoices skill's `quotes`) as a page the customer
-- reads at a private link and accepts by typing their name. Applied with
-- applySchema after the invoices skill's schema, every start and deploy:
-- additive only, no semicolons inside a statement, no double hyphens inside
-- a string.

-- On a quote: the components ticked for it, by their key in
-- src/proposals/components/index.ts. A component's design and words are its
-- own code, written from the brand record; nothing here but the choice.
create table if not exists quote_components (
  quote_id  bigint not null,
  key       text not null check (key ~ '^[a-z][a-z0-9-]{1,39}$'),
  primary key (quote_id, key)
);

-- One per quote: its title, what happens when they sign, its page as one
-- self-contained file (re-made on every save), its link (only the SHA-256
-- of the token is kept), when the link was last emailed, the follow-up
-- task, and a decline's reason.
create table if not exists quote_proposals (
  quote_id         bigint primary key,
  title            text,
  first_invoice    text not null default 'none' check (first_invoice in ('none', 'draft', 'send')),
  deposit_percent  integer check (deposit_percent between 1 and 100),
  page_html        text,
  page_sha256      text,
  rendered_at      timestamptz,
  token_sha256     text,
  link_made_at     timestamptz,
  link_made_by     citext,
  emailed_at       timestamptz,
  followed_up_at   timestamptz,
  decline_reason   text,
  decline_note     text,
  updated_by       citext,
  updated_at       timestamptz not null default now()
);
create unique index if not exists quote_proposals_token on quote_proposals (token_sha256) where token_sha256 is not null;

-- Every open of a live link. `who`: the customer, someone signed in to the
-- team (the edge names them), or a mail scanner (a view within a minute of
-- the link being emailed). Only a customer's view makes the quote Viewed.
create table if not exists quote_views (
  id          bigserial primary key,
  quote_id    bigint not null,
  at          timestamptz not null default now(),
  who         text not null check (who in ('customer', 'team', 'scanner')),
  ip          text,
  browser     text
);
create index if not exists quote_views_quote on quote_views (quote_id, at desc);

-- The signature: the typed name, the email the link went to, when, from
-- where, and the page exactly as signed with its SHA-256.
create table if not exists quote_signatures (
  quote_id    bigint primary key,
  name        text not null,
  email       citext,
  signed_at   timestamptz not null default now(),
  ip          text,
  browser     text,
  page_html   text not null,
  page_sha256 text not null
);

comment on table quote_proposals is 'A quote as the customer''s page (CRM proposals): its title, what signing does, the page, its link''s SHA-256.';
comment on table quote_signatures is 'A customer''s signature on a proposal: typed name, email, time, IP, browser, and the page as signed with its SHA-256.';
comment on table quote_views is 'Every open of a proposal''s live link: customer, team (signed in), or scanner (within a minute of the email).';

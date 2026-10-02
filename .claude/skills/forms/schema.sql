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

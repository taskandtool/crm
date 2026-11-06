-- The latest figures per key ("seo",
-- "seo:acme"), saved by a job on the machine and read by the page wherever
-- it runs.
create table if not exists report_snapshots (
  key text primary key,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);

-- What was spent on ads, a row per day and ad, saved by a daily job from the ad platform
-- (ad-spend.ts). Source, campaign and ad are tags as `forms/origin.ts` stores them, so they
-- match the leads those ads brought; '' where the platform gives no finer level.
create table if not exists ad_spend (
  day date not null,
  source text not null,
  campaign text not null default '',
  content text not null default '',
  spend_cents bigint not null check (spend_cents >= 0),
  currency text not null,
  clicks integer,
  impressions integer,
  updated_at timestamptz not null default now(),
  primary key (day, source, campaign, content)
);

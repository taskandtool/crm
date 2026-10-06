-- The reports skill's one table: the latest figures per key ("seo",
-- "seo:acme"), saved by a job on the machine and read by the page wherever
-- it runs. Additive only (data/SKILL.md).
create table if not exists report_snapshots (
  key text primary key,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);

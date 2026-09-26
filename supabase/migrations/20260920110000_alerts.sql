-- Alert storage + RLS.
--
-- RECOVERED FROM THE LIVE DATABASE. This migration ran against the project on
-- 2026-09-19 (remote version 20260919204024) but its file was never committed,
-- so the repo could not rebuild the schema: 20260925200000_weather_alerts.sql
-- ALTERs public.alerts, and a clean deploy failed there on a table nothing had
-- created. Recovered verbatim from supabase_migrations.schema_migrations
-- rather than reconstructed, so it matches what actually ran.

create table public.alerts (
  id           uuid primary key default gen_random_uuid(),
  farm_id      uuid not null references public.farms (id) on delete cascade,
  type         text not null check (type in ('drought', 'low_yield')),
  message      text not null,
  severity     text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  triggered_at timestamptz not null default now(),
  resolved     boolean not null default false,
  resolved_at  timestamptz,
  emailed_at   timestamptz
);

create index on public.alerts (farm_id, resolved, triggered_at desc);

-- One OPEN alert of each type per farm. Re-running the evaluator every time a
-- prediction is requested would otherwise pile up identical rows; the partial
-- unique index makes the dedupe a database guarantee rather than a
-- check-then-insert race in application code.
create unique index alerts_one_open_per_type
  on public.alerts (farm_id, type)
  where resolved = false;

alter table public.alerts enable row level security;

-- Readable and resolvable by the farm's owner, derived through farm_id the
-- same way satellite_features and predictions are. No insert policy: only the
-- service writes alerts, so a farmer cannot fabricate one.
create policy "own farm alerts readable" on public.alerts
  for select using (exists (
    select 1 from public.farms f where f.id = farm_id and f.owner_id = auth.uid()
  ));

create policy "own farm alerts resolvable" on public.alerts
  for update using (exists (
    select 1 from public.farms f where f.id = farm_id and f.owner_id = auth.uid()
  )) with check (exists (
    select 1 from public.farms f where f.id = farm_id and f.owner_id = auth.uid()
  ));

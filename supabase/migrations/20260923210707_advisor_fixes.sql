-- Security-advisor fixes: PostGIS out of public, and RLS policies rewritten.
--
-- RECOVERED FROM THE LIVE DATABASE (remote version 20260923210707). Like the
-- alerts migration, this ran against the project but was never committed.
-- Recovered verbatim rather than reconstructed.
--
-- Two classes of fix, both flagged by Supabase's own advisors:
--
-- 1. PostGIS moved out of `public` into `extensions`. An extension in public
--    puts its functions on every role's search path.
--
-- 2. Every policy re-created with `to authenticated` and with auth.uid()
--    wrapped as `(select auth.uid())`. The wrap is not cosmetic: a bare
--    auth.uid() is re-evaluated per ROW, so the planner cannot hoist it and a
--    scan over n rows calls it n times. As a subquery it is evaluated once
--    per statement. `to authenticated` stops the policy being considered at
--    all for anon, which is both faster and clearer about intent.

drop extension if exists postgis;
create extension if not exists postgis schema extensions;

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

drop policy "own farms readable"   on public.farms;
drop policy "own farms insertable" on public.farms;
drop policy "own farms updatable"  on public.farms;
drop policy "own farms deletable"  on public.farms;

create policy "own farms readable" on public.farms
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "own farms insertable" on public.farms
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "own farms updatable" on public.farms
  for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "own farms deletable" on public.farms
  for delete to authenticated using (owner_id = (select auth.uid()));

drop policy "own farm features readable" on public.satellite_features;
create policy "own farm features readable" on public.satellite_features
  for select to authenticated using (exists (
    select 1 from public.farms f where f.id = farm_id and f.owner_id = (select auth.uid())
  ));

drop policy "own farm predictions readable" on public.predictions;
create policy "own farm predictions readable" on public.predictions
  for select to authenticated using (exists (
    select 1 from public.farms f where f.id = farm_id and f.owner_id = (select auth.uid())
  ));

drop policy "own farm alerts readable"   on public.alerts;
drop policy "own farm alerts resolvable" on public.alerts;
create policy "own farm alerts readable" on public.alerts
  for select to authenticated using (exists (
    select 1 from public.farms f where f.id = farm_id and f.owner_id = (select auth.uid())
  ));
create policy "own farm alerts resolvable" on public.alerts
  for update to authenticated
  using (exists (
    select 1 from public.farms f where f.id = farm_id and f.owner_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.farms f where f.id = farm_id and f.owner_id = (select auth.uid())
  ));

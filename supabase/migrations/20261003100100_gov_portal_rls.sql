-- Government portal — row level security.
--
-- The portal's browser talks to Postgres directly through PostgREST with the
-- anon key, exactly as the farmer side does. RLS is therefore not a second line
-- of defence, it is the ONLY line: there is no API layer in front of a select,
-- so a district manager who edits the request URL gets whatever these policies
-- allow and nothing more. Every rule in the brief is implemented here rather
-- than in the frontend, and the frontend's role-based navigation is a
-- convenience on top -- hiding a menu item is not access control.
--
-- ---------------------------------------------------------------------------
-- THE RECURSION TRAP, and why the helpers below are SECURITY DEFINER
--
-- Scoping any table by "the caller's district" means reading the caller's
-- gov_profiles row. If a policy ON gov_profiles does that with a plain
-- subquery, evaluating the policy requires evaluating the policy, and Postgres
-- aborts with "infinite recursion detected in policy for relation". The
-- standard fix is a SECURITY DEFINER function: it runs as its owner, so it is
-- not subject to RLS on the table it reads, and the recursion never starts.
--
-- A SECURITY DEFINER function that reads a table is a privilege escalation if
-- it can be made to return somebody else's data. These cannot: every one is
-- keyed on `id = auth.uid()` with no parameter that could widen it, so the
-- most a caller can learn is their own tier, their own district, and whether a
-- district id they already hold is theirs. Execute is revoked from anon below.
--
-- `stable` lets the planner call them once per statement rather than once per
-- row; `set search_path` stops a caller shadowing `gov_profiles` with
-- something of their own on the session search path.
-- ---------------------------------------------------------------------------

create or replace function public.gov_tier()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.tier from public.gov_profiles p
  where p.id = (select auth.uid()) and p.status = 'active'
$$;

create or replace function public.gov_district_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.district_id from public.gov_profiles p
  where p.id = (select auth.uid()) and p.status = 'active'
$$;

create or replace function public.gov_designation()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.designation from public.gov_profiles p
  where p.id = (select auth.uid()) and p.status = 'active'
$$;

-- The one predicate every analytical table's read policy uses.
--
-- Returns true for a super admin (province-wide) and for a scoped user whose
-- own district matches. A deactivated account matches nothing, so suspending
-- an account revokes its data access immediately without touching policies --
-- which is the whole reason `status` is checked inside the helpers and not
-- only at login.
--
-- EXISTS rather than comparing gov_tier() and gov_district_id() separately:
-- one index lookup on the primary key instead of two, and it cannot be
-- accidentally satisfied by a NULL district on both sides.
create or replace function public.gov_can_read(d uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.gov_profiles p
    where p.id = (select auth.uid())
      and p.status = 'active'
      and (p.tier = 'super_admin' or p.district_id = d)
  )
$$;

-- Nothing anonymous ever needs these, and an unauthenticated caller would only
-- ever get NULL back -- but being explicit keeps the functions off the anon
-- role's reachable surface entirely.
--
-- THE GRANT BACK TO `authenticated` IS NOT OPTIONAL. Postgres grants EXECUTE on
-- a new function to PUBLIC implicitly, and `authenticated` holds it only through
-- that. Revoking from PUBLIC therefore takes it away from authenticated too --
-- and because every policy below CALLS one of these functions, and a policy
-- expression is evaluated with the querying role's privileges, revoking without
-- re-granting would make every single policy raise "permission denied for
-- function gov_tier" and lock out every real user. Revoke then grant, in that
-- order.
revoke execute on function public.gov_tier()          from public, anon;
revoke execute on function public.gov_district_id()   from public, anon;
revoke execute on function public.gov_designation()   from public, anon;
revoke execute on function public.gov_can_read(uuid)  from public, anon;

grant execute on function public.gov_tier()         to authenticated;
grant execute on function public.gov_district_id()  to authenticated;
grant execute on function public.gov_designation()  to authenticated;
grant execute on function public.gov_can_read(uuid) to authenticated;

-- ============================================================== enable RLS
--
-- Every table, no exceptions. A government table left without RLS is readable
-- by anyone holding the anon key, which is shipped in the browser bundle.
alter table public.gov_districts               enable row level security;
alter table public.gov_crops                   enable row level security;
alter table public.gov_seasons                 enable row level security;
alter table public.gov_profiles                enable row level security;
alter table public.gov_yield_predictions       enable row level security;
alter table public.gov_yield_actuals           enable row level security;
alter table public.gov_satellite_indices       enable row level security;
alter table public.gov_crop_area_estimates     enable row level security;
alter table public.gov_harvest_progress        enable row level security;
alter table public.gov_risk_alerts             enable row level security;
alter table public.gov_subsidy_recommendations enable row level security;
alter table public.gov_field_surveys           enable row level security;
alter table public.gov_datasets                enable row level security;

-- ============================================================== profiles
--
-- Read. Two policies, because the two cases are genuinely different: your own
-- row is always visible (an employee has to be able to see their own
-- designation on screen 14), and beyond that you see only what your tier
-- allows.
drop policy if exists "gov own profile readable" on public.gov_profiles;
create policy "gov own profile readable" on public.gov_profiles
  for select to authenticated
  using (id = (select auth.uid()));

-- gov_can_read(district_id) does the tier split by itself. For a super admin it
-- is true for every row, including the district_manager rows and other super
-- admins (whose district_id is NULL). For a district manager it is true only
-- where the row's district equals theirs -- and NULL = <uuid> is NULL, not
-- true, so a scoped manager never sees a super admin's row.
drop policy if exists "gov scoped profiles readable" on public.gov_profiles;
create policy "gov scoped profiles readable" on public.gov_profiles
  for select to authenticated
  using (public.gov_can_read(district_id));

-- Write. The hierarchy, stated as two policies and nothing else.
--
-- NO SELF-UPDATE POLICY EXISTS, and that is the mechanism that satisfies "an
-- employee must never be able to elevate their own designation or district
-- assignment". It is not a check that could be got round by a cleverly shaped
-- row -- there is simply no policy under which a caller's own row is a legal
-- UPDATE target. A super admin's own row has tier 'super_admin', which the
-- first policy's USING excludes; a district manager's own row has tier
-- 'district_manager', which the second policy's USING excludes. Account
-- details are changed by the tier above, which is exactly what the design's
-- Settings screen tells the user ("the account is managed by your
-- administrator").
--
-- created_by = auth.uid() on every insert makes the provisioning chain
-- unforgeable: you cannot create an account and attribute it to someone else.
drop policy if exists "gov super admin provisions district managers" on public.gov_profiles;
create policy "gov super admin provisions district managers" on public.gov_profiles
  for insert to authenticated
  with check (
    public.gov_tier() = 'super_admin'
    and tier = 'district_manager'
    and district_id is not null
    and created_by = (select auth.uid())
  );

drop policy if exists "gov super admin updates district managers" on public.gov_profiles;
create policy "gov super admin updates district managers" on public.gov_profiles
  for update to authenticated
  using (public.gov_tier() = 'super_admin' and tier = 'district_manager')
  with check (
    public.gov_tier() = 'super_admin'
    and tier = 'district_manager'          -- cannot promote to super_admin
    and district_id is not null            -- cannot un-scope a manager
  );

drop policy if exists "gov district manager provisions employees" on public.gov_profiles;
create policy "gov district manager provisions employees" on public.gov_profiles
  for insert to authenticated
  with check (
    public.gov_tier() = 'district_manager'
    and tier = 'employee'
    and district_id = public.gov_district_id()   -- own district only
    and created_by = (select auth.uid())
  );

drop policy if exists "gov district manager updates employees" on public.gov_profiles;
create policy "gov district manager updates employees" on public.gov_profiles
  for update to authenticated
  using (
    public.gov_tier() = 'district_manager'
    and tier = 'employee'
    and district_id = public.gov_district_id()
  )
  with check (
    public.gov_tier() = 'district_manager'
    and tier = 'employee'                        -- cannot promote to manager
    and district_id = public.gov_district_id()   -- cannot move out of district
  );

-- No DELETE policy on gov_profiles, deliberately. Removal is `status =
-- 'deactivated'`, which keeps the created_by audit chain intact and keeps the
-- officer_id on every survey the account ever submitted resolvable. A deleted
-- account would orphan its own ground truth.

-- ============================================================== dimensions
--
-- gov_crops and gov_seasons carry no district, so there is nothing to scope:
-- any active profile may read them. They are the vocabulary the portal is
-- written in, not data about anyone.
drop policy if exists "gov crops readable" on public.gov_crops;
create policy "gov crops readable" on public.gov_crops
  for select to authenticated
  using (public.gov_tier() is not null);

drop policy if exists "gov seasons readable" on public.gov_seasons;
create policy "gov seasons readable" on public.gov_seasons
  for select to authenticated
  using (public.gov_tier() is not null);

-- gov_districts IS scoped, because "read access scoped to their own district_id
-- only across every table" includes the district list itself. The visible
-- consequence is intended: a district manager's province map renders their one
-- district, which is what "District Manager sees only their own district's
-- data by default" asks for, and the dashboard's district count comes from the
-- same query so it stays consistent instead of promising rows the user cannot
-- then fetch.
drop policy if exists "gov districts readable in scope" on public.gov_districts;
create policy "gov districts readable in scope" on public.gov_districts
  for select to authenticated
  using (public.gov_can_read(id));

-- ============================================================== analytics
--
-- SELECT ONLY. There is no INSERT, UPDATE or DELETE policy on any of the six
-- tables below, which is what makes "never writable from this portal's client
-- at any tier" structural: with RLS enabled and no write policy, every write
-- from `authenticated` is refused regardless of tier, designation or payload.
-- The ml-service writes them with the service_role key, which bypasses RLS
-- entirely and is never shipped to a browser.
drop policy if exists "gov yield predictions readable in scope" on public.gov_yield_predictions;
create policy "gov yield predictions readable in scope" on public.gov_yield_predictions
  for select to authenticated using (public.gov_can_read(district_id));

drop policy if exists "gov yield actuals readable in scope" on public.gov_yield_actuals;
create policy "gov yield actuals readable in scope" on public.gov_yield_actuals
  for select to authenticated using (public.gov_can_read(district_id));

drop policy if exists "gov satellite indices readable in scope" on public.gov_satellite_indices;
create policy "gov satellite indices readable in scope" on public.gov_satellite_indices
  for select to authenticated using (public.gov_can_read(district_id));

drop policy if exists "gov crop area readable in scope" on public.gov_crop_area_estimates;
create policy "gov crop area readable in scope" on public.gov_crop_area_estimates
  for select to authenticated using (public.gov_can_read(district_id));

drop policy if exists "gov harvest progress readable in scope" on public.gov_harvest_progress;
create policy "gov harvest progress readable in scope" on public.gov_harvest_progress
  for select to authenticated using (public.gov_can_read(district_id));

drop policy if exists "gov risk alerts readable in scope" on public.gov_risk_alerts;
create policy "gov risk alerts readable in scope" on public.gov_risk_alerts
  for select to authenticated using (public.gov_can_read(district_id));

drop policy if exists "gov subsidy readable in scope" on public.gov_subsidy_recommendations;
create policy "gov subsidy readable in scope" on public.gov_subsidy_recommendations
  for select to authenticated using (public.gov_can_read(district_id));

-- ============================================================== field surveys
--
-- The one table an employee writes, and the gate is the DESIGNATION, not the
-- tier: an analyst is an employee too, and an analyst does not do field work.
--
-- Four conditions on insert, each closing a different hole:
--   officer_id = auth.uid()        -- cannot file a survey under someone else's name
--   district_id = own district     -- cannot file against another district
--   status = 'pending'             -- cannot submit a survey already marked verified
--   reviewed_by is null            -- nor attribute a review that never happened
drop policy if exists "gov officers submit surveys" on public.gov_field_surveys;
create policy "gov officers submit surveys" on public.gov_field_surveys
  for insert to authenticated
  with check (
    public.gov_designation() in ('agriculture_officer', 'district_officer')
    and officer_id = (select auth.uid())
    and district_id = public.gov_district_id()
    and status = 'pending'
    and reviewed_by is null
  );

drop policy if exists "gov surveys readable in scope" on public.gov_field_surveys;
create policy "gov surveys readable in scope" on public.gov_field_surveys
  for select to authenticated using (public.gov_can_read(district_id));

-- Verify / reject. Only the two admin tiers, only inside their own scope, and
-- the reviewer is pinned to the caller so an adjudication cannot be attributed
-- elsewhere. gov_can_read covers the scope test for both tiers at once: a
-- super admin passes on tier, a manager on district.
drop policy if exists "gov managers adjudicate surveys" on public.gov_field_surveys;
create policy "gov managers adjudicate surveys" on public.gov_field_surveys
  for update to authenticated
  using (
    public.gov_tier() in ('district_manager', 'super_admin')
    and public.gov_can_read(district_id)
  )
  with check (
    public.gov_tier() in ('district_manager', 'super_admin')
    and public.gov_can_read(district_id)
    and reviewed_by = (select auth.uid())
  );

-- ============================================================== datasets
--
-- district_id NULL means province-wide reference data (the Sentinel-2
-- composites, CHIRPS rainfall and so on). Readable by every active profile,
-- because a district manager needs to know which sources their own numbers
-- came from; writable only by a super admin, because a province-wide dataset
-- is a province-wide claim.
drop policy if exists "gov datasets readable in scope" on public.gov_datasets;
create policy "gov datasets readable in scope" on public.gov_datasets
  for select to authenticated
  using (
    (district_id is null and public.gov_tier() is not null)
    or public.gov_can_read(district_id)
  );

drop policy if exists "gov admins upload datasets" on public.gov_datasets;
create policy "gov admins upload datasets" on public.gov_datasets
  for insert to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and (
      public.gov_tier() = 'super_admin'
      or (public.gov_tier() = 'district_manager' and district_id = public.gov_district_id())
    )
  );

drop policy if exists "gov admins update datasets" on public.gov_datasets;
create policy "gov admins update datasets" on public.gov_datasets
  for update to authenticated
  using (
    public.gov_tier() = 'super_admin'
    or (public.gov_tier() = 'district_manager' and district_id = public.gov_district_id())
  )
  with check (
    public.gov_tier() = 'super_admin'
    or (public.gov_tier() = 'district_manager' and district_id = public.gov_district_id())
  );

-- ============================================================== anon lockout
--
-- Supabase grants the anon and authenticated roles table privileges on new
-- public tables by default. RLS already refuses anon on every policy above
-- (all are `to authenticated`), so this changes no outcome -- it removes the
-- privilege as well as the policy, so an anon request fails at the grant and
-- never reaches a policy at all.
revoke all on public.gov_districts               from anon;
revoke all on public.gov_crops                   from anon;
revoke all on public.gov_seasons                 from anon;
revoke all on public.gov_profiles                from anon;
revoke all on public.gov_yield_predictions       from anon;
revoke all on public.gov_yield_actuals           from anon;
revoke all on public.gov_satellite_indices       from anon;
revoke all on public.gov_crop_area_estimates     from anon;
revoke all on public.gov_harvest_progress        from anon;
revoke all on public.gov_risk_alerts             from anon;
revoke all on public.gov_subsidy_recommendations from anon;
revoke all on public.gov_field_surveys           from anon;
revoke all on public.gov_datasets                from anon;

-- Writes that have no policy are refused by RLS, but the grant is also wrong:
-- `authenticated` should not hold INSERT/UPDATE/DELETE on a pipeline-owned
-- table at all. Removing it means a mistake in a future migration -- adding a
-- permissive policy by accident -- still cannot turn into a write.
revoke insert, update, delete on public.gov_yield_predictions       from authenticated;
revoke insert, update, delete on public.gov_yield_actuals           from authenticated;
revoke insert, update, delete on public.gov_satellite_indices       from authenticated;
revoke insert, update, delete on public.gov_crop_area_estimates     from authenticated;
revoke insert, update, delete on public.gov_harvest_progress        from authenticated;
revoke insert, update, delete on public.gov_risk_alerts             from authenticated;
revoke insert, update, delete on public.gov_subsidy_recommendations from authenticated;
revoke delete on public.gov_profiles      from authenticated;
revoke delete on public.gov_field_surveys from authenticated;
revoke delete on public.gov_datasets      from authenticated;
revoke insert, update, delete on public.gov_districts from authenticated;
revoke insert, update, delete on public.gov_crops     from authenticated;
revoke insert, update, delete on public.gov_seasons   from authenticated;

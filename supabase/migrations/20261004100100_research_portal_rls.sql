-- Researcher portal — row level security.
--
-- Same threat model as the government portal: the browser talks to Postgres
-- directly through PostgREST with the anon key, so there is no API layer in
-- front of a select and RLS is the ONLY line of defence. The portal's
-- conditional navigation (lib/access.js) is a convenience on top -- not
-- rendering a button is courtesy, not enforcement.
--
-- ---------------------------------------------------------------------------
-- WHERE THE PERMISSION CHECK ACTUALLY HAPPENS
--
-- The brief asks for Action A/B to be rejected "server-side even if the UI is
-- bypassed". That rejection lives in the INSERT policies on model_runs below,
-- not in the ML service, and the division of labour is deliberate:
--
--   1. the PORTAL inserts a model_runs row with job_status='queued'. RLS
--      decides here whether this account may run (Action A) or train (Action
--      B) at all. A crafted PostgREST request from a researcher with neither
--      flag is refused by Postgres.
--   2. the portal POSTs that row's id to the ML service, which executes on a
--      daemon thread and writes progress back with the service_role key.
--
-- So the authorisation decision is made once, by the database, at the moment
-- the row is created -- and the ML service does not re-implement it. A row
-- that exists is a row somebody was allowed to create.
--
-- The insert policies additionally pin job_status='queued' and every metric
-- column to null. Without that, a researcher holding can_run_models could
-- POST a row that is already 'completed' with r2 = 0.99 and it would appear on
-- screen 4 as a real result. Metrics are writable only by service_role.
--
-- ---------------------------------------------------------------------------
-- THE RECURSION TRAP (same as the government portal)
--
-- Scoping anything by "the caller's tier" means reading the caller's
-- research_profiles row. A policy ON research_profiles that does that with a
-- plain subquery makes evaluating the policy require evaluating the policy,
-- and Postgres aborts with "infinite recursion detected in policy for
-- relation". Hence SECURITY DEFINER helpers: they run as their owner, are not
-- subject to RLS on the table they read, and the recursion never starts.
--
-- Each is keyed on `id = auth.uid()` with no parameter that could widen it, so
-- the most a caller can learn is their own tier and their own flags.
-- `stable` lets the planner call them once per statement rather than per row;
-- `set search_path` stops a caller shadowing research_profiles with something
-- of their own.
-- ---------------------------------------------------------------------------

-- ============================================================== helpers

create or replace function public.research_tier()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.tier from public.research_profiles p
  where p.id = (select auth.uid()) and p.status = 'active'
$$;

-- THE SHARED SUPER ADMIN.
--
-- "the project's existing top-level admin, shared with/mirrored from the
-- government portal's tier if one already exists" -- so a person who is
-- super_admin in gov_profiles is super_admin here, with or without a
-- research_profiles row of their own. Checking both tables is what makes the
-- tier genuinely shared rather than a second thing to remember to provision.
create or replace function public.research_is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.research_profiles p
    where p.id = (select auth.uid()) and p.status = 'active' and p.tier = 'super_admin'
  ) or exists (
    select 1 from public.gov_profiles g
    where g.id = (select auth.uid()) and g.status = 'active' and g.tier = 'super_admin'
  )
$$;

-- Any active membership of this portal. A government super admin qualifies
-- without a row here, which is the point of the function above.
create or replace function public.research_active()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.research_profiles p
    where p.id = (select auth.uid()) and p.status = 'active'
  ) or public.research_is_super_admin()
$$;

-- Action A gate. A lead carries both flags as a table constraint, so this
-- needs no tier special case beyond the shared super admin.
create or replace function public.research_can_run()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.research_profiles p
    where p.id = (select auth.uid()) and p.status = 'active' and p.can_run_models
  ) or public.research_is_super_admin()
$$;

-- Action B gate. Covers dataset upload too: the brief folds upload into
-- train/retrain rather than gating it separately.
create or replace function public.research_can_train()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.research_profiles p
    where p.id = (select auth.uid()) and p.status = 'active' and p.can_train_models
  ) or public.research_is_super_admin()
$$;

-- Action C gate. TIER, not a flag -- "never available to a plain researcher
-- regardless of their flags". A researcher with both flags still fails this.
create or replace function public.research_can_promote()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.research_tier() = 'research_lead'
      or public.research_is_super_admin()
$$;

-- ============================================================== grants
--
-- ORDER MATTERS AND IS THE WHOLE POINT OF THIS BLOCK.
--
-- `authenticated` can execute these only through the implicit grant that every
-- function gives to PUBLIC. Revoking from PUBLIC takes that away, and because
-- every policy below CALLS these functions -- and a policy expression is
-- evaluated with the querying role's privileges -- revoking without an
-- explicit re-grant locks every user out of every table with
-- "permission denied for function research_tier".
--
-- The government portal migration was nearly shipped with these in the wrong
-- order. Grant first, then revoke.
grant execute on function public.research_tier()            to authenticated;
grant execute on function public.research_is_super_admin()  to authenticated;
grant execute on function public.research_active()          to authenticated;
grant execute on function public.research_can_run()         to authenticated;
grant execute on function public.research_can_train()       to authenticated;
grant execute on function public.research_can_promote()     to authenticated;

revoke execute on function public.research_tier()           from public, anon;
revoke execute on function public.research_is_super_admin() from public, anon;
revoke execute on function public.research_active()         from public, anon;
revoke execute on function public.research_can_run()        from public, anon;
revoke execute on function public.research_can_train()      from public, anon;
revoke execute on function public.research_can_promote()    from public, anon;

-- ============================================================== enable RLS
--
-- The init migration's rls_auto_enable() event trigger has already done this
-- for each table, but stating it is not redundant: it documents the intent and
-- it keeps this file correct if these tables are ever created by some path
-- that trigger does not cover.
alter table public.research_profiles     enable row level security;
alter table public.dataset_versions      enable row level security;
alter table public.model_runs            enable row level security;
alter table public.model_run_logs        enable row level security;
alter table public.model_status_history  enable row level security;
alter table public.benchmark_references  enable row level security;

-- ============================================================== column grants
--
-- NARROWING UPDATE ON model_runs TO THE STATUS COLUMN ALONE.
--
-- An RLS policy cannot restrict WHICH COLUMNS an update touches -- only which
-- rows. So an UPDATE policy permissive enough for Action C to promote a model
-- would also let a research lead rewrite r2 on a finished run. Column
-- privileges are the right tool, and together with the policy below they make
-- Action C's promise exact: a lead may change `status`, and nothing else, and
-- only on a training row.
--
-- Supabase's default privileges grant ALL on new public tables to
-- authenticated, so this has to revoke before it re-grants.
revoke update on public.model_runs from authenticated;
grant  update (status) on public.model_runs to authenticated;

-- Metrics, job_status, logs and version labels are written by the ML service
-- with the service_role key, which bypasses RLS entirely. No client may write
-- them, which is why there is no grant here for them.
revoke insert, update, delete on public.model_run_logs       from authenticated;
revoke insert, update, delete on public.model_status_history from authenticated;
grant  select on public.model_run_logs       to authenticated;
grant  select on public.model_status_history to authenticated;

-- ============================================================== profiles
--
-- Read. Your own row is always visible -- a researcher has to be able to see
-- their own flags on screen 11 -- and beyond that you see only what your tier
-- allows: a super admin sees everyone, a lead sees the researchers they
-- created. A researcher sees nobody but themselves.
drop policy if exists "research own profile readable" on public.research_profiles;
create policy "research own profile readable" on public.research_profiles
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists "research admins read profiles" on public.research_profiles;
create policy "research admins read profiles" on public.research_profiles
  for select to authenticated
  using (
    public.research_is_super_admin()
    or (public.research_tier() = 'research_lead' and created_by = (select auth.uid()))
  );

-- Insert. Two policies because the two tiers may create different things, and
-- both enforce "no role may grant a tier equal to or higher than its own":
--
--   super_admin   -> research_lead, researcher      (NOT another super_admin)
--   research_lead -> researcher                     (NOT another lead)
--   researcher    -> nothing at all
--
-- created_by is pinned to the caller, so a provisioned account cannot be
-- attributed to somebody else, and status is pinned to 'active' because
-- creating a pre-deactivated account is not a workflow this portal has.
drop policy if exists "research super admin provisions leads" on public.research_profiles;
create policy "research super admin provisions leads" on public.research_profiles
  for insert to authenticated
  with check (
    public.research_is_super_admin()
    and tier in ('research_lead', 'researcher')
    and created_by = (select auth.uid())
    and status = 'active'
  );

drop policy if exists "research leads provision researchers" on public.research_profiles;
create policy "research leads provision researchers" on public.research_profiles
  for insert to authenticated
  with check (
    public.research_tier() = 'research_lead'
    and tier = 'researcher'
    and created_by = (select auth.uid())
    and status = 'active'
  );

-- Update.
--
-- `id <> auth.uid()` IN BOTH POLICIES IS THE MECHANISM behind "no account can
-- ever change its own permission flags or its own tier". There is no
-- self-update policy, so the escalation is ABSENT rather than checked for --
-- the same approach the government portal takes. A super admin cannot raise
-- their own privileges either, because they already have all of them and
-- because leaving the hole open for one tier is how it gets used.
--
-- The WITH CHECK tier predicate is what stops escalation THROUGH an update:
-- RLS sees the old row in USING and the new row in WITH CHECK, so pinning the
-- permitted tier set on the new row means no update can move an account up.
drop policy if exists "research super admin updates profiles" on public.research_profiles;
create policy "research super admin updates profiles" on public.research_profiles
  for update to authenticated
  using (
    public.research_is_super_admin()
    and id <> (select auth.uid())
  )
  with check (
    public.research_is_super_admin()
    and id <> (select auth.uid())
    and tier in ('research_lead', 'researcher')
  );

drop policy if exists "research leads update their researchers" on public.research_profiles;
create policy "research leads update their researchers" on public.research_profiles
  for update to authenticated
  using (
    public.research_tier() = 'research_lead'
    and created_by = (select auth.uid())
    and id <> (select auth.uid())
  )
  with check (
    public.research_tier() = 'research_lead'
    and created_by = (select auth.uid())
    and id <> (select auth.uid())
    and tier = 'researcher'
  );

-- No delete policy, at any tier. Accounts are DEACTIVATED, never removed:
-- model_runs.triggered_by and dataset_versions.uploaded_by point here, and
-- deleting a researcher would either orphan or erase the attribution on work
-- that is cited in a report.

-- ============================================================== datasets
--
-- Read for every active member, uploader irrelevant -- "lists all
-- dataset_versions available for training/running, regardless of who uploaded
-- them".
drop policy if exists "research reads dataset versions" on public.dataset_versions;
create policy "research reads dataset versions" on public.dataset_versions
  for select to authenticated
  using (public.research_active());

-- Upload is part of Action B, so it takes can_train_models. An account with
-- can_run_models but not can_train_models can SELECT an existing
-- dataset_version for Action A and cannot create one -- exactly as the brief
-- splits it.
--
-- schema_validated is pinned false on insert: only the ML service's validator
-- may declare a file valid, and it does so with service_role.
drop policy if exists "research trainers register datasets" on public.dataset_versions;
create policy "research trainers register datasets" on public.dataset_versions
  for insert to authenticated
  with check (
    public.research_can_train()
    and uploaded_by = (select auth.uid())
    and schema_validated = false
  );

-- No client update or delete. A dataset_version is an immutable snapshot --
-- that is what makes a run reproducible. Editing one would silently change the
-- meaning of every run that cites it.

-- ============================================================== model runs
--
-- Read for every active member, including one with neither flag: "a Researcher
-- with neither flag can still open the Performance Comparison screen and view
-- results from runs/trainings that others have completed".
drop policy if exists "research reads model runs" on public.model_runs;
create policy "research reads model runs" on public.model_runs
  for select to authenticated
  using (public.research_active());

-- ACTION A -- run an existing model to evaluate it.
--
-- Every condition closes a hole:
--   run_kind='evaluation'  this path cannot create a model version
--   status is null         so it can never be promoted, and the table
--                          constraint already forbids a status on an evaluation
--   research_can_run()     the flag gate, server side
--   triggered_by = uid     attribution cannot be forged
--   job_status='queued'    and all metrics null -- a client cannot POST a
--                          finished run with invented numbers
drop policy if exists "research runs evaluations" on public.model_runs;
create policy "research runs evaluations" on public.model_runs
  for insert to authenticated
  with check (
    run_kind = 'evaluation'
    and status is null
    and public.research_can_run()
    and triggered_by = (select auth.uid())
    and job_status = 'queued'
    and started_at is null
    and completed_at is null
    and version_label is null
    and r2 is null and rmse is null and mae is null
    and accuracy is null and precision_score is null
    and recall is null and f1_score is null
    and confusion_matrix is null
  );

-- ACTION B -- train or retrain.
--
-- `status = 'candidate'` in WITH CHECK is what makes "every training run always
-- produces a new model version with status = candidate -- never any other
-- status, regardless of what it was trained from" STRUCTURAL. A client that
-- POSTs status='production' is refused by Postgres, not corrected by the UI.
-- Retraining from a production model is therefore safe by construction: the
-- parent's status has no influence on the child's.
drop policy if exists "research trains models" on public.model_runs;
create policy "research trains models" on public.model_runs
  for insert to authenticated
  with check (
    run_kind = 'training'
    and status = 'candidate'
    and public.research_can_train()
    and triggered_by = (select auth.uid())
    and job_status = 'queued'
    and started_at is null
    and completed_at is null
    and r2 is null and rmse is null and mae is null
    and accuracy is null and precision_score is null
    and recall is null and f1_score is null
    and confusion_matrix is null
  );

-- ACTION C -- promote.
--
-- The ONLY policy in this portal that updates model_runs, and the column grant
-- above restricts it to the `status` column. `run_kind = 'training'` on both
-- sides means an evaluation row can never be promoted into a version.
--
-- The explicit confirmation step the brief requires is a UI affordance and
-- cannot be enforced here -- a policy cannot tell a confirmed click from an
-- unconfirmed one. What IS enforced is who may do it and what it may touch.
drop policy if exists "research leads promote models" on public.model_runs;
create policy "research leads promote models" on public.model_runs
  for update to authenticated
  using (
    public.research_can_promote()
    and run_kind = 'training'
  )
  with check (
    public.research_can_promote()
    and run_kind = 'training'
    and status in ('candidate', 'approved', 'production', 'archived')
  );

-- No delete policy. "Promoting one model to production does not delete or
-- alter other versions" -- nothing in this portal deletes a run.

-- ============================================================== logs & audit
--
-- Read only, for every active member. Writes come from the ML service
-- (service_role) and from the status trigger below, never from a client --
-- the column grants above already revoked insert/update/delete.
drop policy if exists "research reads run logs" on public.model_run_logs;
create policy "research reads run logs" on public.model_run_logs
  for select to authenticated
  using (public.research_active());

drop policy if exists "research reads status history" on public.model_status_history;
create policy "research reads status history" on public.model_status_history
  for select to authenticated
  using (public.research_active());

-- THE AUDIT TRAIL IS A TRIGGER, NOT A CLIENT INSERT.
--
-- "status change history/audit trail (who promoted what, when)" has to be
-- impossible to skip. If the portal wrote this row itself, a promotion issued
-- straight to PostgREST would change the status and leave no trace -- and that
-- is precisely the request an audit trail exists to catch. A trigger records
-- it whatever the caller is.
--
-- SECURITY DEFINER so the insert is not itself subject to the deny-all write
-- posture on model_status_history. It writes only what it is given and
-- auth.uid() for the actor, so there is nothing a caller can steer.
create or replace function public.research_log_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    insert into public.model_status_history (model_run_id, old_status, new_status, changed_by)
    values (new.id, old.status, new.status, (select auth.uid()));
  end if;
  return new;
end;
$$;

revoke execute on function public.research_log_status_change() from public, anon, authenticated;

drop trigger if exists research_status_audit on public.model_runs;
create trigger research_status_audit
  after update of status on public.model_runs
  for each row
  execute function public.research_log_status_change();

-- ============================================================== benchmarks
--
-- Readable by every active member; editable by a lead or super admin. Which
-- papers are worth comparing against is an editorial judgement, so it sits
-- with the tier that already carries editorial authority rather than behind
-- can_train_models.
drop policy if exists "research reads benchmarks" on public.benchmark_references;
create policy "research reads benchmarks" on public.benchmark_references
  for select to authenticated
  using (public.research_active());

drop policy if exists "research leads write benchmarks" on public.benchmark_references;
create policy "research leads write benchmarks" on public.benchmark_references
  for insert to authenticated
  with check (public.research_can_promote());

drop policy if exists "research leads update benchmarks" on public.benchmark_references;
create policy "research leads update benchmarks" on public.benchmark_references
  for update to authenticated
  using (public.research_can_promote())
  with check (public.research_can_promote());

drop policy if exists "research leads delete benchmarks" on public.benchmark_references;
create policy "research leads delete benchmarks" on public.benchmark_references
  for delete to authenticated
  using (public.research_can_promote());

-- ============================================================== upstream reads
--
-- WHY THESE EXIST AT ALL.
--
-- The government portal's policies are keyed on gov_can_read(district), which
-- requires a gov_profiles row. A researcher has no such row, so without the
-- policies below every one of this portal's analytical screens would come back
-- empty: no districts to filter by, no satellite indices to explore, no
-- predictions to compare against.
--
-- RLS policies are OR'd together, so adding a second SELECT policy to these
-- tables WIDENS access for researchers without altering what a government user
-- sees. Nothing here grants a write: the brief's "yield_predictions,
-- satellite_indices and other upstream operational tables remain fully
-- read-only from this portal" holds because no write policy is added for them,
-- exactly as in the government portal.
--
-- These are DISTRICT-AGGREGATE tables. No policy below reaches public.farms --
-- an individual farmer's rows stay invisible to this portal, as they are to
-- the government one.

-- Dimensions, for every filter on every screen.
drop policy if exists "research reads districts" on public.gov_districts;
create policy "research reads districts" on public.gov_districts
  for select to authenticated using (public.research_active());

drop policy if exists "research reads crops" on public.gov_crops;
create policy "research reads crops" on public.gov_crops
  for select to authenticated using (public.research_active());

drop policy if exists "research reads seasons" on public.gov_seasons;
create policy "research reads seasons" on public.gov_seasons
  for select to authenticated using (public.research_active());

-- Screen 2, Dataset Explorer: the raw temporal feature data.
drop policy if exists "research reads satellite indices" on public.gov_satellite_indices;
create policy "research reads satellite indices" on public.gov_satellite_indices
  for select to authenticated using (public.research_active());

-- Screen 6, Prediction vs Actual: both sides of the comparison.
drop policy if exists "research reads yield predictions" on public.gov_yield_predictions;
create policy "research reads yield predictions" on public.gov_yield_predictions
  for select to authenticated using (public.research_active());

drop policy if exists "research reads yield actuals" on public.gov_yield_actuals;
create policy "research reads yield actuals" on public.gov_yield_actuals
  for select to authenticated using (public.research_active());

-- Screen 6 again: the brief wants ground truth "sourced from the government
-- portal's field survey verification data where available".
--
-- RESTRICTED TO status='verified'. A pending submission is an officer's
-- unreviewed claim and a rejected one was judged wrong; neither is ground
-- truth, and exposing an officer's unadjudicated or overturned work to a
-- different portal is a disclosure the brief does not ask for. Only the
-- adjudicated rows cross the boundary.
drop policy if exists "research reads verified surveys" on public.gov_field_surveys;
create policy "research reads verified surveys" on public.gov_field_surveys
  for select to authenticated
  using (public.research_active() and status = 'verified');

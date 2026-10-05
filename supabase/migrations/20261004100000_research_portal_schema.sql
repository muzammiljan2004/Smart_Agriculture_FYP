-- Researcher portal — schema.
--
-- A THIRD front end over the same Supabase project. The farmer side owns
-- `farms` and `satellite_features`; the government side owns the `gov_*`
-- tables; this one owns the six tables below and WRITES NOTHING ELSE. Every
-- upstream table it touches -- gov_districts, gov_crops, gov_seasons,
-- gov_yield_predictions, gov_satellite_indices, gov_field_surveys -- is read
-- only from here, enforced by the absence of any write policy in the RLS
-- migration rather than by convention.
--
-- DIMENSIONS ARE NOT RE-CREATED. districts, crops and seasons already exist as
-- public.gov_districts / gov_crops / gov_seasons from 20261003100000. A second
-- copy would drift from the first within a season and then two portals would
-- disagree about how many districts Punjab has, so every foreign key below
-- points at the government portal's tables. That makes this migration depend
-- on that one; the timestamp ordering already guarantees it.
--
-- Idempotent throughout (`create table if not exists`, `create index if not
-- exists`, guarded `alter table ... add column`), so it is safe to re-run and
-- safe to replay on a fresh `db reset`.
--
-- NOTE ON RLS: 20260919000000_init.sql installs an `rls_auto_enable()` event
-- trigger that turns RLS on for every new table in `public`. So each table
-- here is RLS-enabled the moment it is created, and until the next migration
-- adds policies it is deny-all. That is the correct failure direction: a
-- half-applied pair of migrations exposes nothing.

-- ============================================================== profiles
--
-- Three tiers, mirroring the government portal's shape so the two read alike:
--
--   super_admin   -- the platform's existing top-level admin. Creates research
--                    leads. Full visibility.
--   research_lead -- scoped admin. Creates and manages researchers, sets their
--                    flags, and may promote a model version.
--   researcher    -- an individual account. What it may DO is carried by two
--                    independent booleans rather than by its tier, because the
--                    brief wants run and train granted separately.
--
-- THE SUPER ADMIN IS SHARED, NOT DUPLICATED. A person who is already
-- super_admin in gov_profiles is treated as super_admin here too -- see
-- research_is_super_admin() in the RLS migration, which checks both tables.
-- That is why this table does not need its own bootstrap for that tier: the
-- government portal's administrator already is one. A row here with
-- tier = 'super_admin' is still allowed, for an admin who has no government
-- portal account at all.
create table if not exists public.research_profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  full_name        text not null,
  tier             text not null
                   check (tier in ('super_admin', 'research_lead', 'researcher')),

  -- The two capability flags. Default FALSE on purpose: a freshly created
  -- researcher can open the analytical screens and trigger nothing, which is
  -- the brief's "a researcher may have one flag, both, or neither".
  can_run_models   boolean not null default false,
  can_train_models boolean not null default false,

  created_by       uuid references public.research_profiles (id) on delete set null,
  status           text not null default 'active'
                   check (status in ('active', 'deactivated')),
  created_at       timestamptz not null default now(),

  -- "Research Lead always has both can_run_models and can_train_models
  -- implicitly" -- made a DB invariant rather than a UI convention, so the
  -- flags can be read directly off the row by both the portal and the RLS
  -- helpers without a tier special-case at every call site.
  constraint research_profiles_lead_flags check (
    tier = 'researcher'
    or (can_run_models and can_train_models)
  )
);

comment on table public.research_profiles is
  'Researcher portal accounts. Invite-only: rows are created by a research_lead '
  'or super_admin, never by sign-up. A person may hold both a gov_profiles row '
  'and a row here; they are independent memberships of two different portals.';
comment on column public.research_profiles.can_run_models is
  'May run an existing model version against a dataset to evaluate it. Never '
  'trains anything. Not self-assignable -- see the RLS update policies.';
comment on column public.research_profiles.can_train_models is
  'May train or retrain a model and upload dataset versions. Always produces a '
  'candidate; never changes any model''s status.';

-- ============================================================== datasets
--
-- A dataset_version is an immutable snapshot, which is what makes a run
-- reproducible: a model_runs row names the exact dataset_version_id it used, so
-- re-running it later cannot silently pick up extra rows.
--
-- storage_path is a path on the ML service's own filesystem, NOT a Supabase
-- Storage object. No bucket is configured in this project and introducing one
-- would be a new piece of infrastructure for the portal's sake; the ML service
-- already reads its training data from `ml-service/data/`, so an uploaded
-- dataset lands beside it under `ml-service/data/research/`. If Storage is
-- adopted later this column takes the object key unchanged.
create table if not exists public.dataset_versions (
  id               uuid primary key default gen_random_uuid(),
  description      text not null,
  storage_path     text not null,
  record_count     integer not null default 0 check (record_count >= 0),

  -- Set by the ML service's validator, not by the client. False means the file
  -- arrived but failed the temporal-schema check; the row is still kept so the
  -- failure is visible on screen 3 rather than vanishing.
  schema_validated boolean not null default false,
  validation_notes text,

  uploaded_by      uuid references public.research_profiles (id) on delete set null,
  created_at       timestamptz not null default now()
);

comment on column public.dataset_versions.schema_validated is
  'False = the upload failed the date-indexed NDVI/EVI/NDWI/SAVI/NBR + weather '
  '+ soil column check. The row is retained so the failure is reportable.';

-- ============================================================== model runs
--
-- ONE TABLE, TWO KINDS OF ROW, and `run_kind` is what separates them. The brief
-- asks for Action A's evaluations and Action B's trainings to both be saved
-- here, but they are not the same thing:
--
--   run_kind = 'training'    a MODEL VERSION. Carries `status`
--                            (candidate/approved/production/archived) and is
--                            what Action A's picker and screen 8 list.
--   run_kind = 'evaluation'  a READ-ONLY SCORING of one or more existing
--                            versions. Carries no status -- it is not a
--                            version and can never be promoted.
--
-- Without this column the two are indistinguishable, and Action A's model
-- picker would offer its own past evaluations as things to evaluate. The
-- constraint below is what guarantees an evaluation can never acquire a status
-- and so can never become what the pipeline serves.
create table if not exists public.model_runs (
  id                   uuid primary key default gen_random_uuid(),
  run_kind             text not null check (run_kind in ('evaluation', 'training')),

  model_type           text not null
                       check (model_type in ('RandomForest', 'XGBoost', 'CNN', 'LSTM')),
  -- Human-readable version identifier for the status-badged pickers, e.g.
  -- 'RandomForest-v3'. Assigned by the ML service on training; null on an
  -- evaluation row, which has no version of its own.
  version_label        text,

  -- Scope. All three nullable: a model trained across every district has no
  -- single district_id, and the brief's filters treat null as "all".
  crop_id              uuid references public.gov_crops (id)     on delete set null,
  district_id          uuid references public.gov_districts (id) on delete set null,
  season_id            uuid references public.gov_seasons (id)   on delete set null,

  dataset_version_id   uuid references public.dataset_versions (id) on delete restrict,

  -- Split ratio, hyperparameters, target scope, and for a retrain the base
  -- version. Free-form because the ML service owns what is meaningful here.
  run_config           jsonb not null default '{}'::jsonb,

  -- Action A supports multi-select across statuses in one comparison run; this
  -- holds the model_runs ids that were scored together.
  models_selected      uuid[] not null default '{}'::uuid[],

  -- Lineage, set ONLY on a retrain. A null parent means trained from scratch.
  parent_model_run_id  uuid references public.model_runs (id) on delete set null,

  triggered_by         uuid references public.research_profiles (id) on delete set null,

  job_status           text not null default 'queued'
                       check (job_status in ('queued', 'running', 'completed', 'failed')),
  started_at           timestamptz,
  completed_at         timestamptz,

  -- Version status. NULL for an evaluation (see the constraint below).
  status               text check (status in ('candidate', 'approved', 'production', 'archived')),

  -- Which metric set applies. The brief is explicit that classification
  -- metrics must never be shown for a regression run, so the row says which it
  -- is rather than the UI guessing from which columns are non-null.
  output_type          text check (output_type in ('regression', 'classification')),

  r2                   numeric,
  rmse                 numeric,
  mae                  numeric,
  accuracy             numeric,
  precision_score      numeric,
  recall               numeric,
  f1_score             numeric,
  confusion_matrix     jsonb,

  error_message        text,
  created_at           timestamptz not null default now(),

  -- A training is a version and must have a status; an evaluation is not and
  -- must not. This is the invariant that makes "running a model never changes
  -- what the pipeline serves" structural rather than merely intended.
  constraint model_runs_status_scope check (
    (run_kind = 'training'   and status is not null) or
    (run_kind = 'evaluation' and status is null)
  ),

  -- A row cannot be its own parent.
  constraint model_runs_parent_not_self check (parent_model_run_id is distinct from id)
);

comment on table public.model_runs is
  'Model versions (run_kind=training) and read-only evaluations '
  '(run_kind=evaluation). Only a training row has a status and can be promoted.';
comment on column public.model_runs.precision_score is
  'Named precision_score, not precision: PRECISION is a Postgres type keyword '
  '(double precision), and while it is accepted as a column name it has to be '
  'quoted in enough contexts that the suffix is cheaper than the surprise. '
  'Matches the f1_score naming already used beside it.';
comment on column public.model_runs.models_selected is
  'For a multi-model comparison evaluation: the model_runs ids scored together.';

-- AT MOST ONE PRODUCTION VERSION PER ALGORITHM.
--
-- Action C is the only writer of `status`, and "promoting one model to
-- production does not delete other versions -- the previously-production model
-- becomes archived" is its job. This index is what stops a bug in that path
-- leaving two live production models of the same type, which would make
-- "what does the pipeline serve?" unanswerable. Per model_type rather than
-- globally, so a production LSTM and a production RandomForest can coexist.
create unique index if not exists model_runs_one_production_per_type
  on public.model_runs (model_type)
  where status = 'production';

-- ============================================================== run logs
--
-- Append-only progress lines for the live job view on screen 7.
--
-- NO QUEUE AND NO REALTIME SUBSCRIPTION. The project has neither; the only
-- existing async mechanism is the daemon thread in app/gee.py. So the ML
-- service runs a training on a daemon thread and appends here as it goes, and
-- the portal POLLS job_status plus these lines on an interval -- the same
-- useQuery/reload path every other screen already uses. Noted in the summary.
create table if not exists public.model_run_logs (
  id           bigserial primary key,
  model_run_id uuid not null references public.model_runs (id) on delete cascade,
  log_line     text not null,
  logged_at    timestamptz not null default now()
);

-- ============================================================== status audit
--
-- Who promoted what, when. Written by Action C alongside the status change.
-- Kept in its own table rather than as a jsonb column on model_runs so a
-- promotion cannot be silently rewritten by an update to the version row.
create table if not exists public.model_status_history (
  id           uuid primary key default gen_random_uuid(),
  model_run_id uuid not null references public.model_runs (id) on delete cascade,
  old_status   text,
  new_status   text not null,
  changed_by   uuid references public.research_profiles (id) on delete set null,
  note         text,
  changed_at   timestamptz not null default now()
);

-- ============================================================== benchmarks
--
-- Literature values for screen 9. Editable by a lead, because which papers are
-- worth comparing against is an editorial judgement, not data.
create table if not exists public.benchmark_references (
  id           uuid primary key default gen_random_uuid(),
  citation     text not null,
  metric_type  text not null,
  metric_value numeric,
  crop_type    text,
  notes        text,
  created_at   timestamptz not null default now()
);

-- ============================================================== indexes
--
-- Every foreign key the brief names, plus the three columns the screens filter
-- and sort on hardest (status, job_status, run_kind). Postgres does NOT index a
-- foreign key automatically -- only the referenced side gets one from its
-- primary key -- so without these, screen 4's "group by crop and status" is a
-- sequential scan of every run ever recorded.
create index if not exists model_runs_crop_idx            on public.model_runs (crop_id);
create index if not exists model_runs_district_idx        on public.model_runs (district_id);
create index if not exists model_runs_season_idx          on public.model_runs (season_id);
create index if not exists model_runs_dataset_idx         on public.model_runs (dataset_version_id);
create index if not exists model_runs_parent_idx          on public.model_runs (parent_model_run_id);
create index if not exists model_runs_triggered_by_idx    on public.model_runs (triggered_by);
create index if not exists model_runs_status_idx          on public.model_runs (status);
create index if not exists model_runs_job_status_idx      on public.model_runs (job_status);
create index if not exists model_runs_kind_type_idx       on public.model_runs (run_kind, model_type);
create index if not exists model_runs_created_idx         on public.model_runs (created_at desc);

create index if not exists model_run_logs_run_idx
  on public.model_run_logs (model_run_id, logged_at);

create index if not exists model_status_history_run_idx
  on public.model_status_history (model_run_id, changed_at desc);

create index if not exists dataset_versions_uploader_idx  on public.dataset_versions (uploaded_by);
create index if not exists dataset_versions_created_idx   on public.dataset_versions (created_at desc);

create index if not exists research_profiles_created_by_idx on public.research_profiles (created_by);
create index if not exists research_profiles_tier_idx       on public.research_profiles (tier, status);

create index if not exists benchmark_references_crop_idx    on public.benchmark_references (crop_type);

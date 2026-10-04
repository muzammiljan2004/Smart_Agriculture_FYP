-- Government & Policy-Maker Portal — schema.
--
-- A SECOND, READ-ONLY AUDIENCE over the same database. Nothing here touches
-- public.farms or any farmer-side table: the two sides never join, and a
-- government user has no policy granting them a single farm row. The portal
-- reads district-level aggregates only, which is also what makes it safe --
-- there is no path from an aggregate back to an individual farmer's field.
--
-- Grain is uniform and deliberate: (district, crop, season) on every analytical
-- table, with a date added where a series is involved. That is the grain the
-- real data already has -- data/training_data_real.csv is one row per
-- district-crop-season -- so the schema matches the pipeline instead of asking
-- it to reshape.
--
-- Three dimension tables rather than the text columns public.farms uses. The
-- farmer side stores `district text` with a CHECK because the browser writes it
-- directly through PostgREST and a CHECK is the only validation an insert gets.
-- Here every analytical row is written by the pipeline under service_role, so a
-- real FK is both affordable and worth more: it gives the portal something to
-- join district names and boundaries onto, which a text column cannot.

-- ============================================================== dimensions

-- PostGIS lives in `extensions`, not `public` -- see 20260923210707. The
-- schema-qualified type is required; a bare `geometry` does not resolve.
create table if not exists public.gov_districts (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  province   text not null default 'Punjab',
  -- TODO(boundaries): NULL for every row. Real district polygons need a
  -- shapefile import that is not part of this task -- the candidate source is
  -- FAO GAUL level 2, which the GEE pipeline already resolves districts
  -- against by name (ml-service/app/gee.py), so the names here will match it.
  -- Until then the portal draws approximate cells from district seed points;
  -- see frontend/src/gov/lib/geo.js, which says so on the map legend.
  geom       extensions.geometry(MultiPolygon, 4326),
  created_at timestamptz not null default now()
);

comment on column public.gov_districts.geom is
  'NULL until real boundaries are imported from FAO GAUL level 2. The portal '
  'falls back to approximate cells and labels them as approximate.';

create table if not exists public.gov_crops (
  id       uuid primary key default gen_random_uuid(),
  name     text not null unique,
  -- Botanical family, mirroring data/crops.csv `family`. Named `category`
  -- because that is what the portal groups by, and because the next useful
  -- grouping (cereal / fibre / vegetable) is also a category, not a family.
  category text,
  -- rabi / kharif / zaid / annual, same vocabulary as public.farms.season.
  season   text not null check (season in ('rabi', 'kharif', 'zaid', 'annual'))
);

-- A season LABEL, not a calendar year: rabi 2024-25 spans two of them. The
-- label is the join key the training data already uses ('2024-25'), so it has
-- to be preserved verbatim rather than normalised to an integer.
create table if not exists public.gov_seasons (
  id         uuid primary key default gen_random_uuid(),
  label      text not null unique,
  start_date date not null,
  end_date   date not null,
  check (end_date > start_date)
);

-- ============================================================== access tiers
--
-- CHECK constraints rather than Postgres enums, for the reason given in
-- 20260919120000: adding a value to an enum needs ALTER TYPE (which cannot run
-- in every transaction context) and removing one is worse, while a CHECK is
-- edited by one migration and PostgREST reports a violation as a readable 400.
-- `designation` is explicitly meant to be extended, so that matters here.
--
-- created_by is the provisioning chain, and it is the audit trail for the whole
-- hierarchy: every account except the seeded super admin points at whoever made
-- it. ON DELETE SET NULL rather than CASCADE -- removing a manager must not
-- silently delete the officers they created.
create table if not exists public.gov_profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null,
  tier        text not null check (tier in ('super_admin', 'district_manager', 'employee')),
  designation text check (designation in ('agriculture_officer', 'district_officer', 'analyst')),
  district_id uuid references public.gov_districts (id) on delete restrict,
  created_by  uuid references public.gov_profiles (id) on delete set null,
  status      text not null default 'active' check (status in ('active', 'deactivated')),
  created_at  timestamptz not null default now(),

  -- The hierarchy as a database invariant, not an application convention. RLS
  -- below decides WHO may write a row; these decide whether the row is even a
  -- coherent account, so a service_role script cannot create an incoherent one
  -- either.
  --
  -- A super admin is province-wide, so a district would contradict the tier.
  -- Every other tier is scoped, so a NULL district would silently widen it.
  constraint gov_profiles_district_scope check (
    (tier = 'super_admin'      and district_id is null) or
    (tier in ('district_manager', 'employee') and district_id is not null)
  ),
  -- Designation decides an employee's screen and write access, so an employee
  -- without one has undefined permissions. The two admin tiers derive theirs
  -- from the tier itself and must not carry a second, conflicting source.
  constraint gov_profiles_designation_scope check (
    (tier = 'employee' and designation is not null) or
    (tier in ('super_admin', 'district_manager') and designation is null)
  )
);

create index if not exists gov_profiles_district_idx   on public.gov_profiles (district_id);
create index if not exists gov_profiles_created_by_idx on public.gov_profiles (created_by);
create index if not exists gov_profiles_tier_idx       on public.gov_profiles (tier, status);

-- ============================================================== analytics
--
-- Every table below is READ-ONLY to the portal. They are written by the
-- existing ml-service under service_role, which bypasses RLS; no INSERT or
-- UPDATE policy is created for them further down, which is what makes the
-- restriction structural rather than a matter of the frontend behaving.
--
-- Each carries the same (district, crop, season) FK triple. The composite
-- indexes are not optional: every RLS policy on these tables filters on
-- district_id, so without one each policy evaluation is a sequential scan.

-- Model output. `actual_yield` deliberately lives on the GROUND TRUTH side
-- (see gov_yield_actuals) and not here -- mixing a prediction and an
-- observation in one row is how a validation plot ends up comparing a column
-- against itself.
create table if not exists public.gov_yield_predictions (
  id              uuid primary key default gen_random_uuid(),
  district_id     uuid not null references public.gov_districts (id) on delete cascade,
  crop_id         uuid not null references public.gov_crops (id)     on delete cascade,
  season_id       uuid not null references public.gov_seasons (id)   on delete cascade,
  predicted_yield double precision not null check (predicted_yield >= 0 and predicted_yield < 120),
  -- Separate columns rather than the numrange public.predictions uses. The
  -- portal charts the band as two series, and PostgREST exposes a range as an
  -- opaque string the frontend would have to parse.
  ci_low          double precision check (ci_low  >= 0),
  ci_high         double precision check (ci_high >= 0),
  model_used      text not null,
  -- How many days before harvest the forecast was made. This is the entire
  -- point of screen 7's lead-time comparison, so it is a column rather than
  -- something inferred from created_at: a forecast re-run today for a past
  -- season would otherwise claim a negative lead time.
  lead_days       integer check (lead_days between 0 and 365),
  -- Whether this row is a real forecast or a fit to data the model was trained
  -- on. Without it the portal cannot tell the two apart, and a chart of
  -- in-sample fits looks like a chart of accurate forecasts -- the single most
  -- misleading thing this schema could permit. 'in_sample' rows are shown
  -- labelled; screen 7's accuracy figures are computed from 'holdout' only.
  evaluation      text not null default 'out_of_sample'
                  check (evaluation in ('in_sample', 'holdout', 'out_of_sample')),
  created_at      timestamptz not null default now(),
  check (ci_low is null or ci_high is null or ci_high >= ci_low),
  unique (district_id, crop_id, season_id, lead_days)
);

create index if not exists gov_yield_predictions_dcs_idx
  on public.gov_yield_predictions (district_id, crop_id, season_id);
create index if not exists gov_yield_predictions_created_idx
  on public.gov_yield_predictions (created_at desc);

-- Reported yields, for the "forecast vs actual" and historical-trend screens.
-- NOT in the spec's table list, and added anyway: screen 6 is "historical and
-- current statistics" and screen 9 ranks districts against "historical
-- average". Without an actuals table both would have to treat model output as
-- history, which is the one comparison that must never be faked.
create table if not exists public.gov_yield_actuals (
  id          uuid primary key default gen_random_uuid(),
  district_id uuid not null references public.gov_districts (id) on delete cascade,
  crop_id     uuid not null references public.gov_crops (id)     on delete cascade,
  season_id   uuid not null references public.gov_seasons (id)   on delete cascade,
  yield_t_ha  double precision not null check (yield_t_ha >= 0 and yield_t_ha < 120),
  -- Provenance travels with the number. data/training_data_real.csv already
  -- distinguishes a directly reported CRS estimate from an interpolated one,
  -- and a portal that shows both without saying which is which is worse than
  -- one that shows neither.
  source      text not null default 'PBS',
  confidence  text,
  unique (district_id, crop_id, season_id)
);

create index if not exists gov_yield_actuals_dcs_idx
  on public.gov_yield_actuals (district_id, crop_id, season_id);

-- Spectral indices at district grain. Distinct from public.satellite_features,
-- which is per FARM: same five bands, different unit of observation, and they
-- must not be conflated -- a district mean over a 500 m composite is not a
-- field reading, and the LOSO work in experimental/ exists precisely because
-- the two behave differently.
create table if not exists public.gov_satellite_indices (
  id          uuid primary key default gen_random_uuid(),
  district_id uuid not null references public.gov_districts (id) on delete cascade,
  crop_id     uuid not null references public.gov_crops (id)     on delete cascade,
  season_id   uuid not null references public.gov_seasons (id)   on delete cascade,
  date        date not null,
  ndvi        double precision check (ndvi between -1 and 1),
  evi         double precision check (evi  between -1 and 1),
  ndwi        double precision check (ndwi between -1 and 1),
  savi        double precision check (savi between -1 and 1),
  nbr         double precision check (nbr  between -1 and 1),
  source      text,
  unique (district_id, crop_id, season_id, date)
);

create index if not exists gov_satellite_indices_dcs_date_idx
  on public.gov_satellite_indices (district_id, crop_id, season_id, date desc);
create index if not exists gov_satellite_indices_date_idx
  on public.gov_satellite_indices (date desc);

create table if not exists public.gov_crop_area_estimates (
  id                 uuid primary key default gen_random_uuid(),
  district_id        uuid not null references public.gov_districts (id) on delete cascade,
  crop_id            uuid not null references public.gov_crops (id)     on delete cascade,
  season_id          uuid not null references public.gov_seasons (id)   on delete cascade,
  estimated_area_ha  double precision not null check (estimated_area_ha >= 0),
  prev_season_area_ha double precision check (prev_season_area_ha >= 0),
  -- Classification accuracy against survey points, where it is known. Null
  -- means unvalidated, and the portal says "not validated" rather than
  -- printing a plausible-looking percentage.
  accuracy_pct       double precision check (accuracy_pct between 0 and 100),
  method             text,
  unique (district_id, crop_id, season_id)
);

create index if not exists gov_crop_area_estimates_dcs_idx
  on public.gov_crop_area_estimates (district_id, crop_id, season_id);

create table if not exists public.gov_harvest_progress (
  id                 uuid primary key default gen_random_uuid(),
  district_id        uuid not null references public.gov_districts (id) on delete cascade,
  crop_id            uuid not null references public.gov_crops (id)     on delete cascade,
  season_id          uuid not null references public.gov_seasons (id)   on delete cascade,
  harvested_area_ha  double precision not null check (harvested_area_ha >= 0),
  remaining_area_ha  double precision not null check (remaining_area_ha >= 0),
  last_updated       timestamptz not null default now(),
  unique (district_id, crop_id, season_id)
);

create index if not exists gov_harvest_progress_dcs_idx
  on public.gov_harvest_progress (district_id, crop_id, season_id);
create index if not exists gov_harvest_progress_updated_idx
  on public.gov_harvest_progress (last_updated desc);

-- Authority-side alerts. A SEPARATE TABLE from public.alerts on purpose:
-- public.alerts is per-farm and is emailed to the farmer, and the spec is
-- explicit that these must never reach one. Different audience, different
-- grain, different delivery -- sharing a table would mean one mistaken join
-- away from mailing a provincial drought warning to every farmer in it.
create table if not exists public.gov_risk_alerts (
  id           uuid primary key default gen_random_uuid(),
  district_id  uuid not null references public.gov_districts (id) on delete cascade,
  crop_id      uuid references public.gov_crops (id)   on delete cascade,
  season_id    uuid references public.gov_seasons (id) on delete cascade,
  alert_type   text not null check (alert_type in ('drought', 'flood', 'water_stress', 'anomaly')),
  severity     text not null check (severity in ('low', 'medium', 'high')),
  message      text not null,
  -- Why the rule fired, in machine-readable form: the threshold, the observed
  -- value, the comparison window. The portal shows it, so a reviewer can tell
  -- a real signal from a cloud artefact without opening the pipeline.
  details      jsonb not null default '{}'::jsonb,
  triggered_at timestamptz not null default now(),
  resolved     boolean not null default false
);

create index if not exists gov_risk_alerts_district_idx
  on public.gov_risk_alerts (district_id, resolved, triggered_at desc);
create index if not exists gov_risk_alerts_type_idx
  on public.gov_risk_alerts (alert_type, severity);

-- Subsidy targeting. `reason` is NOT NULL because the spec requires the
-- ranking rationale to be visible per row, and a nullable column would let a
-- row exist that the UI has to render as a blank justification for moving
-- public money.
create table if not exists public.gov_subsidy_recommendations (
  id                   uuid primary key default gen_random_uuid(),
  district_id          uuid not null references public.gov_districts (id) on delete cascade,
  crop_id              uuid not null references public.gov_crops (id)     on delete cascade,
  season_id            uuid not null references public.gov_seasons (id)   on delete cascade,
  resource_type        text not null default 'water'
                       check (resource_type in ('water', 'fertilizer', 'seed', 'credit')),
  rank                 integer not null check (rank > 0),
  reason               text not null,
  -- The two halves of the documented rule, stored separately so the UI can
  -- show that BOTH conditions were met rather than only a combined score.
  yield_deficit_pct    double precision,
  resource_access_score double precision check (resource_access_score between 0 and 1),
  priority_score       double precision check (priority_score between 0 and 1),
  created_at           timestamptz not null default now(),
  unique (district_id, crop_id, season_id, resource_type)
);

create index if not exists gov_subsidy_recommendations_rank_idx
  on public.gov_subsidy_recommendations (season_id, crop_id, resource_type, rank);
create index if not exists gov_subsidy_recommendations_district_idx
  on public.gov_subsidy_recommendations (district_id);

-- ============================================================== portal-native
--
-- The only two tables the portal itself writes, and the only two with INSERT
-- policies below.

create table if not exists public.gov_field_surveys (
  id             uuid primary key default gen_random_uuid(),
  officer_id     uuid not null references public.gov_profiles (id) on delete restrict,
  district_id    uuid not null references public.gov_districts (id) on delete cascade,
  crop_id        uuid not null references public.gov_crops (id)     on delete cascade,
  season_id      uuid not null references public.gov_seasons (id)   on delete cascade,
  survey_type    text not null check (survey_type in
                 ('crop_type', 'sowing_date', 'harvest_progress', 'yield_cut')),
  sowing_date    date,
  harvest_date   date,
  verified_yield double precision check (verified_yield is null or
                 (verified_yield >= 0 and verified_yield < 120)),
  observed_value text,
  notes          text,
  gps_lat        double precision check (gps_lat is null or gps_lat between -90 and 90),
  gps_lng        double precision check (gps_lng is null or gps_lng between -180 and 180),
  status         text not null default 'pending'
                 check (status in ('pending', 'verified', 'rejected')),
  -- Who adjudicated, and when. Null while pending. This is the ground truth
  -- that will eventually validate the model, so the reviewer has to be
  -- recorded -- an unattributed "verified" is not verification.
  reviewed_by    uuid references public.gov_profiles (id) on delete set null,
  reviewed_at    timestamptz,
  submitted_at   timestamptz not null default now(),
  check (status = 'pending' or reviewed_by is not null)
);

create index if not exists gov_field_surveys_district_idx
  on public.gov_field_surveys (district_id, status, submitted_at desc);
create index if not exists gov_field_surveys_officer_idx
  on public.gov_field_surveys (officer_id);
create index if not exists gov_field_surveys_dcs_idx
  on public.gov_field_surveys (district_id, crop_id, season_id);

create table if not exists public.gov_datasets (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  source      text,
  coverage    text,
  file_url    text,
  version     text not null default '1',
  -- NULL means province-wide, which only a super admin may create. A
  -- district_manager's uploads carry their own district, and that is what the
  -- RLS policy checks.
  district_id uuid references public.gov_districts (id) on delete cascade,
  status      text not null default 'pending'
              check (status in ('pending', 'verified', 'flagged')),
  quality_score integer check (quality_score between 0 and 100),
  record_count  bigint check (record_count >= 0),
  uploaded_by uuid references public.gov_profiles (id) on delete set null,
  uploaded_at timestamptz not null default now(),
  unique (name, version)
);

create index if not exists gov_datasets_district_idx on public.gov_datasets (district_id);
create index if not exists gov_datasets_status_idx   on public.gov_datasets (status, uploaded_at desc);

-- Step 2: land profile per farm.
--
-- Three things the farmer knows and no raster does, plus a cached profile of
-- what the land itself offers, sampled once at registration.

-- ------------------------------------------------- farmer-declared fields
--
-- Salinity has no free global raster, and in the southern districts it is
-- often what actually decides whether a crop is growable. The farmer knows
-- their own problem patches; asking is better data than modelling it badly.
alter table public.farms
  add column if not exists water_source  text,
  add column if not exists salinity_flag text,
  add column if not exists last_crop     text;

alter table public.farms
  add constraint farms_water_source_check
  check (water_source is null or water_source in
         ('canal', 'tubewell', 'canal_and_tubewell', 'rainfed'));

alter table public.farms
  add constraint farms_salinity_flag_check
  check (salinity_flag is null or salinity_flag in
         ('none', 'mild', 'severe', 'unknown'));

-- ------------------------------------------------- widen crop and season
--
-- The registry knows 14 crops; the DB previously allowed 2. The DB permits
-- what the SYSTEM understands; the API separately refuses what the MODEL has
-- not been trained on (it already returns 422 listing trained_crops).
--
-- These lists stay CHECK constraints rather than being dropped, because the
-- browser writes public.farms directly through PostgREST -- there is no API
-- layer in front of an insert, so this is the only validation a farm row gets.
--
-- REGENERATE when data/crops.csv changes:
--     python -c "from app.crops import ALL_CROPS, CROP_SEASON; \
--       print(', '.join(repr(c) for c in ALL_CROPS)); \
--       [print(f\"(crop_type='{c}' and season='{CROP_SEASON[c]}') or\") for c in ALL_CROPS]"
alter table public.farms drop constraint if exists farms_crop_season_match;
alter table public.farms drop constraint if exists farms_crop_type_check;
alter table public.farms drop constraint if exists farms_season_check;

alter table public.farms
  add constraint farms_crop_type_check
  check (crop_type in ('bajra', 'barley', 'brinjal', 'chilli', 'cotton', 'garlic',
                       'jowar', 'maize', 'onion', 'potato', 'rice', 'sugarcane',
                       'tomato', 'wheat'));

-- last_crop takes the same list, and null for a farm with no recorded history.
alter table public.farms
  add constraint farms_last_crop_check
  check (last_crop is null or last_crop in
         ('bajra', 'barley', 'brinjal', 'chilli', 'cotton', 'garlic', 'jowar',
          'maize', 'onion', 'potato', 'rice', 'sugarcane', 'tomato', 'wheat'));

alter table public.farms
  add constraint farms_season_check
  check (season in ('rabi', 'kharif', 'zaid', 'annual'));

-- Season is derived from the crop, so it must not drift: a 'rice'/'rabi' row
-- would send the fetch looking for a rice canopy in February, when the field
-- is bare soil.
alter table public.farms
  add constraint farms_crop_season_match
  check (
    (crop_type = 'bajra'     and season = 'kharif') or
    (crop_type = 'barley'    and season = 'rabi')   or
    (crop_type = 'brinjal'   and season = 'zaid')   or
    (crop_type = 'chilli'    and season = 'zaid')   or
    (crop_type = 'cotton'    and season = 'kharif') or
    (crop_type = 'garlic'    and season = 'rabi')   or
    (crop_type = 'jowar'     and season = 'kharif') or
    (crop_type = 'maize'     and season = 'kharif') or
    (crop_type = 'onion'     and season = 'rabi')   or
    (crop_type = 'potato'    and season = 'rabi')   or
    (crop_type = 'rice'      and season = 'kharif') or
    (crop_type = 'sugarcane' and season = 'annual') or
    (crop_type = 'tomato'    and season = 'kharif') or
    (crop_type = 'wheat'     and season = 'rabi')
  );

-- ------------------------------------------------------- land_profiles
--
-- One row per farm. Explicit columns rather than a single jsonb blob so the
-- CHECK constraints below can catch a mis-scaled value at write time: this
-- project has already lost time to a unit error once, and a pH of 77 reaching
-- the suitability engine would silently rule out every crop on earth.
create table public.land_profiles (
  id          uuid primary key default gen_random_uuid(),
  farm_id     uuid not null unique references public.farms (id) on delete cascade,

  -- soil, averaged over the 0-30 cm root zone
  ph              double precision check (ph is null or ph between 3 and 11),
  clay_pct        double precision check (clay_pct is null or clay_pct between 0 and 100),
  silt_pct        double precision check (silt_pct is null or silt_pct between 0 and 100),
  sand_pct        double precision check (sand_pct is null or sand_pct between 0 and 100),
  texture_class   int              check (texture_class is null or texture_class between 1 and 12),
  texture         text,
  bulk_density    double precision check (bulk_density is null or bulk_density between 0.5 and 2.5),
  water_33kpa     double precision check (water_33kpa is null or water_33kpa between 0 and 100),
  -- stored RAW: the OpenLandMap scale factor direction is unverified, so
  -- nothing downstream may threshold on it until someone checks it.
  soc_raw         double precision,

  -- climate normals at the farm coordinates
  tmax_mean_c         double precision,
  tmin_mean_c         double precision,
  tmax_hottest_c      double precision,
  tmin_coldest_c      double precision,
  annual_rain_mm      double precision check (annual_rain_mm is null or annual_rain_mm >= 0),
  frost_days_per_year double precision check (frost_days_per_year is null or frost_days_per_year >= 0),
  climate_years_used  int,
  -- per-month normals, so a crop is judged on ITS window's weather
  monthly             jsonb,

  soil_source    text not null default 'OpenLandMap',
  climate_source text not null default 'Open-Meteo',
  fetched_at     timestamptz not null default now()
);

create index on public.land_profiles (farm_id);

alter table public.land_profiles enable row level security;

-- Read-only to the farmer who owns the farm. Writes come from ml-service with
-- the service_role key, which bypasses RLS, so there is no insert policy here
-- on purpose: a browser must never be able to forge a land profile.
create policy "own land profile readable" on public.land_profiles
  for select using (
    exists (
      select 1 from public.farms f
      where f.id = land_profiles.farm_id and f.owner_id = auth.uid()
    )
  );

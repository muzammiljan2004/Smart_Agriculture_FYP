-- Ground-truth yields + planting dates.
--
-- district_yields is the database mirror of ml-service/data/training.csv: one
-- real (PBS) yield per district-season-crop. It is what makes "compared to
-- district average" and the year-over-year trend real rather than decorative,
-- and it is also how the UI decides whether a district is backed by validated
-- data or is still running on the synthetic model.
--
-- Deliberately NOT a column on farms or predictions: a district average is a
-- property of the district-season, not of any one farm, and duplicating it per
-- farm would go stale the moment a figure is revised.
create table public.district_yields (
  id         uuid primary key default gen_random_uuid(),
  district   text not null check (district in ('Sheikhupura', 'Okara', 'Sahiwal')),
  season     text not null,                    -- '2024-25' (rabi) or '2024' (kharif)
  crop_type  text not null check (crop_type in ('wheat', 'rice')),
  yield_t_ha double precision not null check (yield_t_ha >= 0 and yield_t_ha < 20),
  source     text not null default 'PBS',      -- provenance; 'synthetic' for placeholders
  created_at timestamptz not null default now(),
  unique (district, season, crop_type)
);

-- Every read is "rows for this district+crop, ordered by season".
create index on public.district_yields (district, crop_type, season);

-- Reference data, not personal data: any signed-in farmer may read it, nobody
-- may write it through the API. Writes happen via service_role from the
-- loader script, exactly like satellite_features.
alter table public.district_yields enable row level security;

create policy "district yields readable by signed-in users"
  on public.district_yields
  for select
  to authenticated
  using (true);

-- Growth-stage tracking counts days from sowing. Nullable because existing
-- farms have no value and because a farmer may genuinely not know it; the
-- tracker falls back to the season's conventional sowing date and says so.
alter table public.farms add column planting_date date;

-- A wheat crop sown in July is a data-entry error, not a real farm. Bound it
-- loosely rather than exactly -- sowing windows shift with weather.
alter table public.farms
  add constraint farms_planting_date_sane
  check (planting_date is null or planting_date > date '2015-01-01');

-- Multi-district + real crop dimension.
-- Districts: Sheikhupura, Okara, Sahiwal (scope doc's field-validation set).
-- Crops: wheat (rabi), rice (kharif).

-- CHECK constraints rather than a Postgres enum: adding a district to an enum
-- needs ALTER TYPE (which cannot run inside some transaction contexts) and
-- dropping one is worse. A CHECK is edited by one migration, and PostgREST
-- reports a violation as a readable 400 instead of an opaque type error.
alter table public.farms
  add constraint farms_district_check
  check (district in ('Sheikhupura', 'Okara', 'Sahiwal'));

alter table public.farms
  add constraint farms_crop_type_check
  check (crop_type in ('wheat', 'rice'));

-- Season is derived from the crop, so it must not be free text either:
-- a 'rice'/'rabi' row would send the GEE script looking for a rice canopy in
-- February, when the field is bare soil.
alter table public.farms
  add constraint farms_season_check
  check (season in ('rabi', 'kharif'));

alter table public.farms
  add constraint farms_crop_season_match
  check (
    (crop_type = 'wheat' and season = 'rabi') or
    (crop_type = 'rice'  and season = 'kharif')
  );

-- The default stays 'wheat'/'rabi'; a rice farm must set both, and the
-- constraint above stops it setting only one.

-- Aggregating by district is now a real query pattern (3 districts, not 1).
create index on public.farms (district, crop_type);

-- NOTE: district names here must match the keys of DISTRICTS in
-- ml-service/app/districts.py exactly. If they drift, fetch_satellite_data.py
-- exits with a clear error rather than sampling the wrong bounding box.

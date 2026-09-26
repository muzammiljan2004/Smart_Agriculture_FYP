-- Field-level foundation: area, radar columns, and farmer harvest confirmation.
--
-- Three small additions, no new tables. The lifecycle work needs a field to
-- have a SIZE (a point alone cannot be reduced over), needs radar alongside
-- optical (kharif optical drops to 6-7 usable scenes a month), and needs a
-- place to record what the farmer actually did.

-- ------------------------------------------------------------ farms.area
-- Point + area is deliberately NOT a polygon. A circle of the right area
-- around the pin is enough to reduce imagery over, and asking a farmer to
-- draw a boundary on a phone is the single biggest thing that stops them
-- registering at all. Polygons can replace this later without touching
-- anything downstream -- the extraction takes a geometry either way.
--
-- Upper bound 10000 ha: the largest farms in Punjab are a few hundred
-- hectares, so this rejects a decimal-point slip (5 -> 5000) while never
-- rejecting a real holding. Lower bound excludes 0, which would give a
-- zero-radius circle and reduce over nothing.
alter table public.farms
  add column if not exists area_hectares double precision
  check (area_hectares is null or (area_hectares > 0 and area_hectares <= 10000));

-- ------------------------------------------------- harvest ground truth
-- On farms rather than in a harvest_events table, because the browser writes
-- farms directly through PostgREST and the existing "own farms updatable"
-- policy already covers every column -- a separate table would need its own
-- insert policy, and this is the minimum that works.
--
-- ponytail: one harvest per farm, ever. The repeating lifecycle needs a
-- harvest_events table (farm_id, season, confirmed_date) and this becomes a
-- view over its latest row. Upgrade when the second season of a field is
-- actually being tracked -- not before, because nothing today reads history.
alter table public.farms
  add column if not exists harvest_confirmed boolean not null default false;

alter table public.farms
  add column if not exists actual_harvest_date date;

-- A confirmation without a date is not ground truth, it is a checkbox. The
-- validation script keys on the date, so let the database refuse the
-- half-filled state rather than discovering it during scoring.
alter table public.farms
  drop constraint if exists farms_harvest_date_present;
alter table public.farms
  add constraint farms_harvest_date_present
  check (not harvest_confirmed or actual_harvest_date is not null);

-- Same reasoning as farms_planting_date_sane: bound it loosely. A harvest
-- before Sentinel-2 existed cannot be validated against imagery anyway.
alter table public.farms
  drop constraint if exists farms_harvest_date_sane;
alter table public.farms
  add constraint farms_harvest_date_sane
  check (actual_harvest_date is null or actual_harvest_date > date '2017-01-01');

-- ------------------------------------------- satellite_features: radar
-- Reusing the table rather than adding a sentinel1_features twin. The grain
-- is already right -- unique (farm_id, date) -- and a field observed by both
-- sensors on the same date should be one row, not two that every reader has
-- to join.
--
-- Nullable because the sensors do not share an orbit: most dates carry
-- optical OR radar, not both. A null here means "not observed", which is
-- exactly what the detector needs to distinguish from a real low value.
alter table public.satellite_features add column if not exists vv double precision;
alter table public.satellite_features add column if not exists vh double precision;

-- Scene cloud percentage and the count of unmasked pixels over the field.
-- Kept because "NDVI 0.21" means something different at 400 valid pixels than
-- at 3, and the harvest detector has to weigh a decline by how well observed
-- it was.
alter table public.satellite_features add column if not exists cloud_pct double precision;
alter table public.satellite_features add column if not exists valid_px integer;

-- Which sensor produced the row, so a reader never has to infer it from which
-- columns happen to be null.
alter table public.satellite_features add column if not exists source text;

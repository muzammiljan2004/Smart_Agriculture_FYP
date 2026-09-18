-- Smart Agriculture — Farmer Portal MVP
-- Scope: Sheikhupura district, wheat, Random Forest.

create extension if not exists postgis;

-- ---------------------------------------------------------------- farms
create table public.farms (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade
              default auth.uid(),
  farmer_name text not null,
  gps_lat     double precision not null check (gps_lat between -90 and 90),
  gps_lng     double precision not null check (gps_lng between -180 and 180),
  district    text not null default 'Sheikhupura',
  crop_type   text not null default 'wheat',
  season      text not null default 'rabi',
  created_at  timestamptz not null default now()
);

-- TODO(phase 2): add `geom geometry(Point, 4326) generated always as
-- (ST_SetSRID(ST_MakePoint(gps_lng, gps_lat), 4326)) stored` + a GiST index
-- once we do district polygons / bbox queries. Lat+lng alone covers the MVP.

-- ------------------------------------------------------ satellite_features
create table public.satellite_features (
  id      uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms (id) on delete cascade,
  date    date not null,
  ndvi    double precision,
  evi     double precision,
  ndwi    double precision,
  savi    double precision,
  nbr     double precision,
  unique (farm_id, date)   -- re-running the GEE script upserts instead of duplicating
);

-- ---------------------------------------------------------- predictions
create table public.predictions (
  id                  uuid primary key default gen_random_uuid(),
  farm_id             uuid not null references public.farms (id) on delete cascade,
  predicted_yield     double precision not null,
  confidence_interval numrange,          -- [lo, hi] from the RF tree spread
  model_used          text not null,
  created_at          timestamptz not null default now()
);

-- Postgres does NOT index foreign keys automatically. Every RLS check on the
-- two child tables joins back on farm_id, so without these each policy
-- evaluation is a seq scan.
create index on public.satellite_features (farm_id, date desc);
create index on public.predictions (farm_id, created_at desc);
create index on public.farms (owner_id);

-- ------------------------------------------------------------------- RLS
-- Mandatory, not optional: the frontend talks to Postgres directly with the
-- anon key. RLS is the only thing standing between farmer A and farmer B's
-- rows. The ml-service uses the service_role key, which bypasses RLS entirely.
alter table public.farms              enable row level security;
alter table public.satellite_features enable row level security;
alter table public.predictions        enable row level security;

-- Separate policies per command rather than one FOR ALL: insert needs
-- WITH CHECK (validates the incoming row), select/delete need USING
-- (filters existing rows), update needs both — or a farmer could hand their
-- farm to someone else by updating owner_id.
create policy "own farms readable" on public.farms
  for select using (owner_id = auth.uid());

create policy "own farms insertable" on public.farms
  for insert with check (owner_id = auth.uid());

create policy "own farms updatable" on public.farms
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "own farms deletable" on public.farms
  for delete using (owner_id = auth.uid());

-- Child tables carry no owner_id; ownership is derived through farm_id.
create policy "own farm features readable" on public.satellite_features
  for select using (exists (
    select 1 from public.farms f where f.id = farm_id and f.owner_id = auth.uid()
  ));

create policy "own farm predictions readable" on public.predictions
  for select using (exists (
    select 1 from public.farms f where f.id = farm_id and f.owner_id = auth.uid()
  ));

-- No insert/update policies on the child tables on purpose: only the
-- ml-service writes them, and it uses service_role. A farmer who could insert
-- their own NDVI could fabricate a yield prediction.

-- TODO(phase 2): government role, read-only and aggregate-only.
-- Sketch: store the role in auth.users.raw_app_meta_data (app_metadata is
-- server-writable only — a user CAN edit their own user_metadata, so putting
-- the role there would let anyone promote themselves to government).
--   create policy "gov reads all farms" on public.farms
--     for select using (auth.jwt() -> 'app_metadata' ->> 'role' = 'government');
-- Aggregate-only means never exposing farms directly: build a
-- security_invoker view (district, season, avg yield, farm count) with a
-- HAVING count(*) >= 5 floor so a district with one farm can't be
-- de-anonymised, and grant select on the view instead of the table.

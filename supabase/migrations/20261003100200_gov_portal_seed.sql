-- Government portal — dimension seed and super-admin bootstrap.
--
-- Idempotent throughout: every insert is ON CONFLICT DO NOTHING / DO UPDATE on
-- a natural key, so this file is safe to re-run and safe to replay on a fresh
-- `db reset`. It seeds only the three DIMENSION tables. The analytical tables
-- are loaded separately by ml-service/scripts/seed_gov_portal.py from the real
-- pipeline outputs, because their contents are measurements and belong with the
-- data they come from, not hardcoded into a schema migration.

-- ============================================================== districts
--
-- These 34 are exactly the districts the pipeline has data for: the list is
-- the same one in public.farms' farms_district_check (20260927020000) and in
-- data/district_soil.csv, and it is derived from what was actually fetched.
-- Keeping all three identical is what stops the portal offering a district
-- whose charts would then come back empty.
--
-- Punjab administratively has ~41 districts. The two the design's map draws and
-- this list omits are Nankana Sahib and Chiniot, which were carved out of
-- Sheikhupura and Jhang after the reporting series began, so their yields are
-- still folded into the parent district upstream. Adding them here before the
-- source data splits them would double-count.
--
-- TODO(boundaries): geom stays NULL for every row -- see the column comment in
-- the schema migration. Import FAO GAUL level 2 Punjab polygons and UPDATE by
-- name; the names below are already GAUL-compatible because the GEE pipeline
-- resolves them that way.
insert into public.gov_districts (name, province) values
  ('Attock', 'Punjab'), ('Bahawalnagar', 'Punjab'), ('Bahawalpur', 'Punjab'),
  ('Bhakkar', 'Punjab'), ('Chakwal', 'Punjab'), ('Dera Ghazi Khan', 'Punjab'),
  ('Faisalabad', 'Punjab'), ('Gujranwala', 'Punjab'), ('Gujrat', 'Punjab'),
  ('Hafizabad', 'Punjab'), ('Jhang', 'Punjab'), ('Jhelum', 'Punjab'),
  ('Kasur', 'Punjab'), ('Khanewal', 'Punjab'), ('Khushab', 'Punjab'),
  ('Lahore', 'Punjab'), ('Layyah', 'Punjab'), ('Lodhran', 'Punjab'),
  ('Mandi Bahauddin', 'Punjab'), ('Mianwali', 'Punjab'), ('Multan', 'Punjab'),
  ('Muzaffargarh', 'Punjab'), ('Narowal', 'Punjab'), ('Okara', 'Punjab'),
  ('Pakpattan', 'Punjab'), ('Rahim Yar Khan', 'Punjab'), ('Rajanpur', 'Punjab'),
  ('Rawalpindi', 'Punjab'), ('Sahiwal', 'Punjab'), ('Sargodha', 'Punjab'),
  ('Sheikhupura', 'Punjab'), ('Sialkot', 'Punjab'), ('Toba Tek Singh', 'Punjab'),
  ('Vehari', 'Punjab')
on conflict (name) do nothing;

-- ============================================================== crops
--
-- The 11 crops the production model is trained on, with family and season
-- copied from data/crops.csv. The brief names five (wheat, rice, maize, cotton,
-- sugarcane); all eleven are seeded because the portal's crop selector is
-- driven by this table and the data covers all eleven -- offering five while
-- holding eleven would hide real rows behind a dropdown.
--
-- garlic, brinjal and chilli are in crops.csv but NOT here: they have no
-- model_order, meaning the production model was never trained on them, so the
-- portal has no yield series to show for them.
insert into public.gov_crops (name, category, season) values
  ('wheat',     'poaceae',        'rabi'),
  ('rice',      'poaceae',        'kharif'),
  ('maize',     'poaceae',        'kharif'),
  ('cotton',    'malvaceae',      'kharif'),
  ('sugarcane', 'poaceae',        'annual'),
  ('barley',    'poaceae',        'rabi'),
  ('bajra',     'poaceae',        'kharif'),
  ('jowar',     'poaceae',        'kharif'),
  ('potato',    'solanaceae',     'rabi'),
  ('onion',     'amaryllidaceae', 'rabi'),
  ('tomato',    'solanaceae',     'kharif')
on conflict (name) do update
  set category = excluded.category, season = excluded.season;

-- ============================================================== seasons
--
-- An AGRICULTURAL year, not a calendar one, which is why the label spans two:
-- kharif is sown in the May of the first year and rabi is harvested in the
-- April of the second. The labels match data/training_data_real.csv exactly
-- ('2017-18' … '2024-25') because that column is the join key, and normalising
-- it to an integer here would break every load.
insert into public.gov_seasons (label, start_date, end_date) values
  ('2017-18', '2017-05-01', '2018-04-30'),
  ('2018-19', '2018-05-01', '2019-04-30'),
  ('2019-20', '2019-05-01', '2020-04-30'),
  ('2020-21', '2020-05-01', '2021-04-30'),
  ('2021-22', '2021-05-01', '2022-04-30'),
  ('2022-23', '2022-05-01', '2023-04-30'),
  ('2023-24', '2023-05-01', '2024-04-30'),
  ('2024-25', '2024-05-01', '2025-04-30')
on conflict (label) do update
  set start_date = excluded.start_date, end_date = excluded.end_date;

-- ============================================================== bootstrap
--
-- WHY THIS IS A FUNCTION AND NOT AN INSERT.
--
-- A super admin needs a row in auth.users, and auth.users cannot be seeded
-- honestly from SQL: the password column holds a bcrypt hash, a usable account
-- also needs a matching auth.identities row, and the exact shape of both is
-- Supabase's to change, not ours. Migrations that hand-write those rows produce
-- accounts that cannot log in, or worse, that can log in with a hash committed
-- to the repository.
--
-- So the account is created the normal way -- Supabase Studio › Authentication ›
-- Add user, or the Admin API -- and this function grants it the tier. It is
-- idempotent, it refuses to invent a user, and it never contains a secret.
--
-- BOOTSTRAP, in two steps:
--
--   1. Create the user, if it does not exist yet. Studio › Authentication ›
--      Users › Add user, with "Auto Confirm User" ticked so no confirmation
--      mail is needed.
--
--      ALREADY DONE for this project's first administrator:
--        email: jmuzammil93@gmail.com
--        uid:   a0352dc5-d445-4929-b907-e47833e9d637
--
--   2. Grant the tier. Run this in the SQL editor AFTER this migration has
--      created the table above -- it is the last step of the bootstrap:
--
--        select public.gov_bootstrap_super_admin(
--          'jmuzammil93@gmail.com', 'Provincial Administrator');
--
-- NO PASSWORD IS STORED ANYWHERE IN THIS REPOSITORY, and none should be: the
-- address above is an identifier, not a credential. Whatever password was set
-- in step 1 is the only one that exists.
--
-- Rotate it before the portal is reachable by anyone other than you, and treat
-- this account as break-glass rather than a daily login -- give yourself a
-- district_manager account for ordinary work, so routine use is not carried out
-- by the one account that can mint new administrators.
--
-- After this, the hierarchy is self-sustaining: the super admin creates
-- district managers in screen 14, and each manager creates their own employees.
-- There is no second use for this function unless every super admin is locked
-- out, which is also the reason it is left in place rather than dropped.
create or replace function public.gov_bootstrap_super_admin(
  p_email text,
  p_full_name text default 'Provincial Administrator'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(p_email);

  if v_uid is null then
    raise exception
      'No auth user with email %. Create the user first (Studio > Authentication > '
      'Add user, with Auto Confirm ticked), then call this function again.', p_email;
  end if;

  -- ON CONFLICT so a re-run is a no-op rather than an error, and so a mistakenly
  -- scoped row can be corrected by calling this again. district_id and
  -- designation are forced to NULL because gov_profiles_district_scope and
  -- gov_profiles_designation_scope both require that of a super admin.
  insert into public.gov_profiles (id, full_name, tier, designation, district_id, status)
  values (v_uid, p_full_name, 'super_admin', null, null, 'active')
  on conflict (id) do update
    set tier = 'super_admin',
        designation = null,
        district_id = null,
        status = 'active',
        full_name = excluded.full_name;

  return v_uid;
end;
$$;

-- Only a database administrator in the SQL editor runs this. Leaving it
-- executable by `authenticated` would be a one-call self-promotion to super
-- admin for any logged-in portal user -- which is exactly the escalation every
-- policy in the RLS migration exists to prevent.
revoke execute on function public.gov_bootstrap_super_admin(text, text)
  from public, anon, authenticated;

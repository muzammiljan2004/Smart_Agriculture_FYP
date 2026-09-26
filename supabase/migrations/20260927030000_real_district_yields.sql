-- district_yields could not hold the data it exists to hold.
--
-- The table was seeded with 15 synthetic wheat rows across 3 districts and
-- never repopulated, so every "vs district average" figure in the dashboard
-- was computed from placeholder numbers -- which the UI did say, in a caveat
-- nobody could clear because the real data had nowhere to go.
--
-- Three constraints blocked it, all written when wheat and rice were the only
-- crops:
--
--   crop_type   limited to wheat/rice        -> the 11 trained crops
--   district    limited to 3                 -> the 34 with data
--   yield_t_ha  < 20                         -> see below
--
-- THE CEILING IS THE INTERESTING ONE. 20 t/ha is a sane bound for cereals --
-- wheat tops out near 4 -- and it silently became wrong the moment root and
-- fodder crops entered: PBS records sugarcane at 102.4 t/ha, tomato at 71.0,
-- potato at 39.3, onion at 36.7. A loader would have failed on sugarcane with
-- a constraint violation and no hint that the constraint, not the data, was
-- at fault.
--
-- Raised to 200 rather than removed. The check exists to catch a unit error,
-- and the realistic one here is kg/ha entering as t/ha -- a 1000x mistake that
-- 200 still catches while clearing sugarcane's real ceiling by ~2x.

alter table public.district_yields drop constraint if exists district_yields_crop_type_check;
alter table public.district_yields drop constraint if exists district_yields_district_check;
alter table public.district_yields drop constraint if exists district_yields_yield_t_ha_check;

alter table public.district_yields
  add constraint district_yields_crop_type_check
  check (crop_type in ('bajra', 'barley', 'cotton', 'jowar', 'maize', 'onion',
                       'potato', 'rice', 'sugarcane', 'tomato', 'wheat'));

alter table public.district_yields
  add constraint district_yields_district_check
  check (district in (
    'Attock', 'Bahawalnagar', 'Bahawalpur', 'Bhakkar', 'Chakwal',
    'Dera Ghazi Khan', 'Faisalabad', 'Gujranwala', 'Gujrat', 'Hafizabad',
    'Jhang', 'Jhelum', 'Kasur', 'Khanewal', 'Khushab', 'Lahore', 'Layyah',
    'Lodhran', 'Mandi Bahauddin', 'Mianwali', 'Multan', 'Muzaffargarh',
    'Narowal', 'Okara', 'Pakpattan', 'Rahim Yar Khan', 'Rajanpur',
    'Rawalpindi', 'Sahiwal', 'Sargodha', 'Sheikhupura', 'Sialkot',
    'Toba Tek Singh', 'Vehari'
  ));

alter table public.district_yields
  add constraint district_yields_yield_t_ha_check
  check (yield_t_ha >= 0 and yield_t_ha < 200);

-- The synthetic rows are deleted, not kept alongside. Leaving them would mean
-- a district average silently mixing invented wheat figures with PBS ones.
delete from public.district_yields where source = 'synthetic';

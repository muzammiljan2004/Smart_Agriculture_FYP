-- Open the portal to every district the pipeline actually has data for.
--
-- The CHECK listed three districts -- Sheikhupura, Okara, Sahiwal -- left over
-- from when those were the only ones with a hardcoded bounding box in
-- app/districts.py. That stopped being the real constraint a long time ago:
-- the fetch pipeline resolves geometry from FAO GAUL by NAME, not from those
-- boxes, and the training set now covers 34 districts across 8 seasons with
-- soil profiles for all 34. A farmer in Multan could not register a farm for
-- a district the model had 70+ rows of.
--
-- The list is exactly the districts in data/district_soil.csv, which is
-- itself derived from what was fetched -- so the constraint cannot drift
-- ahead of the data. A district with no soil profile would produce a farm the
-- suitability engine cannot assess, which is worse than refusing it here.
--
-- Browsers write farms directly through PostgREST, so this CHECK is the only
-- validation standing in front of an insert. Dropping it without replacement
-- would leave none.

alter table public.farms drop constraint if exists farms_district_check;

alter table public.farms
  add constraint farms_district_check
  check (district in (
    'Attock', 'Bahawalnagar', 'Bahawalpur', 'Bhakkar', 'Chakwal',
    'Dera Ghazi Khan', 'Faisalabad', 'Gujranwala', 'Gujrat', 'Hafizabad',
    'Jhang', 'Jhelum', 'Kasur', 'Khanewal', 'Khushab', 'Lahore', 'Layyah',
    'Lodhran', 'Mandi Bahauddin', 'Mianwali', 'Multan', 'Muzaffargarh',
    'Narowal', 'Okara', 'Pakpattan', 'Rahim Yar Khan', 'Rajanpur',
    'Rawalpindi', 'Sahiwal', 'Sargodha', 'Sheikhupura', 'Sialkot',
    'Toba Tek Singh', 'Vehari'
  ));

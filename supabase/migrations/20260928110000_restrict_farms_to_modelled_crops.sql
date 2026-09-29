-- farms.crop_type: accept only the 11 crops the pipeline actually covers.
--
-- garlic, brinjal and chilli were selectable in the UI and accepted by the
-- database while having ZERO rows in data/training_data_real.csv -- no
-- satellite indices, no PBS yields, nothing. A farm could be created that no
-- part of the system could ever say anything about.
--
-- The three are not deleted from the crop registry. data/crops.csv still
-- carries their calendars and agronomic requirements, so app/suitability.py
-- can still answer "is my land suited to chilli" and app/growth.py can still
-- stage them. What they cannot be is the crop a FARM is registered as.
--
-- NO DATA IS DESTROYED. Verified before writing this: farms holds only wheat
-- (3) and rice (2), and last_crop is null on every row, so nothing existing
-- violates the tighter constraint. If that ever stops being true, this
-- migration will fail loudly on the ALTER rather than dropping rows -- which
-- is the behaviour we want.
alter table public.farms drop constraint if exists farms_crop_type_check;

alter table public.farms
  add constraint farms_crop_type_check
  check (crop_type in (
    'wheat', 'rice', 'maize', 'sugarcane', 'cotton', 'potato',
    'onion', 'tomato', 'barley', 'bajra', 'jowar'
  ));

-- NOT TOUCHED, deliberately:
--
-- farms_last_crop_check still admits all 14 crops. last_crop records what the
-- farmer grew PREVIOUSLY, for rotation advice. Somebody may perfectly well
-- have grown garlic last season; refusing to record that would lose real
-- history and tell the rotation engine something false.
--
-- farms_crop_season_match still lists all 14 crop/season pairs. It is a
-- disjunction, so the four pairs that crop_type can no longer take are simply
-- unreachable. Narrowing it would add a second place to edit when a crop is
-- promoted, with no behavioural gain.

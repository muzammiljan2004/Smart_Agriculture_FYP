-- Length bounds on the free-text columns a browser can write directly.
--
-- WHY THE DATABASE AND NOT THE FORM. The farmer app and both portals write to
-- these tables through PostgREST with the user's own JWT -- there is no backend
-- in that path. `maxLength` on an <input> is a typing aid; it is not reachable
-- by anything that talks to the API directly, which is every client that is not
-- the form. RLS already decides WHO may write each row; these decide WHAT a row
-- may contain, which RLS has no opinion about.
--
-- Every other user-supplied column on these tables already has a CHECK: crop
-- and district are enumerations, coordinates are ranged, area is 0 < a <= 10000,
-- yields are 0 <= y < 120. Free text was the one category with no bound at all,
-- so a single insert could carry a megabyte into a column that five screens
-- then render.
--
-- The limits are generous on purpose -- the longest value in the table today is
-- 34 characters, so nothing legitimate is anywhere near them. They exist to stop
-- abuse, not to second-guess a long name. Verified against live data before
-- applying: farms 34, gov_profiles 24, research_profiles 22, dataset_versions 26.
--
-- NOT NULL is deliberately not added anywhere here: that is a different
-- decision, with different migration risk, and these columns' nullability is
-- already what each screen expects.

-- A person's name. 120 matches accounts.py's MIN/max validation for the two
-- portals, so the service-side and database-side limits agree rather than
-- disagreeing by a few characters in whichever direction.
alter table public.farms
  drop constraint if exists farms_farmer_name_len,
  add constraint farms_farmer_name_len
    check (char_length(farmer_name) between 1 and 120);

alter table public.gov_profiles
  drop constraint if exists gov_profiles_full_name_len,
  add constraint gov_profiles_full_name_len
    check (char_length(full_name) between 1 and 120);

alter table public.research_profiles
  drop constraint if exists research_profiles_full_name_len,
  add constraint research_profiles_full_name_len
    check (char_length(full_name) between 1 and 120);

-- Survey free text. An officer's observation and note, both optional: the bound
-- applies only when a value is present, so a null stays legal.
alter table public.gov_field_surveys
  drop constraint if exists gov_field_surveys_observed_value_len,
  add constraint gov_field_surveys_observed_value_len
    check (observed_value is null or char_length(observed_value) <= 200);

alter table public.gov_field_surveys
  drop constraint if exists gov_field_surveys_notes_len,
  add constraint gov_field_surveys_notes_len
    check (notes is null or char_length(notes) <= 1000);

-- Dataset description. The service caps this at 300 before inserting; the
-- constraint is what makes the cap true for a row that did not come through it.
alter table public.dataset_versions
  drop constraint if exists dataset_versions_description_len,
  add constraint dataset_versions_description_len
    check (char_length(description) between 1 and 300);

-- Benchmark citations, entered by hand on the researcher portal's benchmark
-- screen -- the one place in that portal where a user types prose.
alter table public.benchmark_references
  drop constraint if exists benchmark_references_citation_len,
  add constraint benchmark_references_citation_len
    check (char_length(citation) between 1 and 300);

alter table public.benchmark_references
  drop constraint if exists benchmark_references_notes_len,
  add constraint benchmark_references_notes_len
    check (notes is null or char_length(notes) <= 1000);

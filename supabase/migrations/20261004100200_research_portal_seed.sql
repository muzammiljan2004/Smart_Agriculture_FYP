-- Researcher portal — benchmark seed and account bootstrap.
--
-- Idempotent: every insert is guarded on a natural key, so this file is safe to
-- re-run and safe to replay on a fresh `db reset`.

-- ============================================================== benchmarks
--
-- READ THIS BEFORE QUOTING ANY ROW BELOW IN A WRITE-UP.
--
-- The brief asks to seed "known literature values already used in the project
-- documentation (Pantazi et al. 2016, Kuwata & Shibasaki 2015, Kang et al.
-- 2020 findings)". Those three papers appear NOWHERE in this repository. The
-- only literature figure the project actually records is the 0.78-0.84 R2
-- expectation hardcoded in ml-service/scripts/train_real.py:491, and that
-- comment cites no paper.
--
-- So the three citations are seeded WITH A NULL metric_value. Writing a number
-- next to a real author's name from memory would put a fabricated result into
-- an academic comparison table, which is a worse outcome than an empty cell --
-- and it is the one error nobody downstream could detect, because it would
-- look exactly like a real citation.
--
-- metric_value is nullable for this reason, screen 9 renders a null as an em
-- dash (the project's convention: a missing value is never 0), and the table is
-- editable by a research lead precisely so these can be filled in from the
-- papers themselves. The `notes` column on each row says what is needed.
--
-- TODO(benchmarks): open each paper, read the reported metric for the stated
-- crop and model, and UPDATE metric_value. Until then screen 9 compares this
-- project's models against the documented 0.78-0.84 band only.
insert into public.benchmark_references (citation, metric_type, metric_value, crop_type, notes)
select * from (values
  ('Pantazi et al. (2016), Computers and Electronics in Agriculture',
   'R2', null::numeric, 'wheat',
   'VALUE NOT SEEDED. Wheat yield prediction from soil and remote sensing with '
   'supervised self-organising maps. The paper reports classification accuracy '
   'per SOM variant rather than a single R2, so the metric_type may need '
   'changing to Accuracy when the figure is entered. Read the paper and fill in.'),

  ('Kuwata & Shibasaki (2015), IEEE IGARSS',
   'R2', null::numeric, 'maize',
   'VALUE NOT SEEDED. Crop yield estimation from remotely sensed data with a '
   'deep neural network, compared against SVR. Read the paper and fill in.'),

  ('Kang et al. (2020), Environmental Research Letters',
   'R2', null::numeric, 'maize',
   'VALUE NOT SEEDED. Comparative assessment of environmental variables and '
   'machine-learning algorithms for maize yield prediction in the US Midwest. '
   'Reports a range across algorithms, so pick the one being compared against '
   'and say which in this note. Read the paper and fill in.'),

  -- The one row with a real, sourced number in it: the project's own recorded
  -- expectation. Two rows, because it is a band and collapsing it to a
  -- midpoint would invent a precision the source does not have.
  ('Project expectation (ml-service/scripts/train_real.py:491)',
   'R2 lower bound', 0.78, 'wheat',
   'Sourced from this repository, not from a paper: the trainer prints a '
   'caveat when holdout R2 falls below 0.78, described there as the '
   '"literature-based 0.78-0.84 expectation". No citation is given at that '
   'line. This is the band the project actually holds itself to.'),

  ('Project expectation (ml-service/scripts/train_real.py:491)',
   'R2 upper bound', 0.84, 'wheat',
   'Upper end of the same recorded band. See the lower-bound row.')
) as v(citation, metric_type, metric_value, crop_type, notes)
where not exists (
  select 1 from public.benchmark_references b
  where b.citation = v.citation and b.metric_type = v.metric_type
);

-- ============================================================== bootstrap
--
-- WHY A FUNCTION AND NOT AN INSERT -- the same reason as the government
-- portal's gov_bootstrap_super_admin.
--
-- An account needs a row in auth.users, and auth.users cannot be seeded
-- honestly from SQL: the password column holds a bcrypt hash, a usable account
-- also needs a matching auth.identities row, and the exact shape of both is
-- Supabase's to change, not ours. A migration that hand-writes those rows
-- produces accounts that cannot log in, or worse, one that can log in with a
-- hash committed to the repository.
--
-- So the auth user is created the normal way -- Supabase Studio >
-- Authentication > Add user, with "Auto Confirm User" ticked -- and this
-- function grants it a tier. It is idempotent, it refuses to invent a user, and
-- IT CONTAINS NO SECRET.
--
-- NO PASSWORD IS STORED ANYWHERE IN THIS REPOSITORY and none should be.
-- Whatever is set in Studio is the only password that exists. Rotate both
-- accounts before anyone else can reach the portal.
--
-- ---------------------------------------------------------------------------
-- BOOTSTRAP, in three steps.
--
-- STEP 0 -- you may not need the super admin at all.
--
--   research_is_super_admin() checks gov_profiles as well as
--   research_profiles, so the project's EXISTING government super admin is
--   already a research super admin with full visibility and promotion rights,
--   with no row in this table. That is the shared tier the brief asks for. Only
--   create a research-side super_admin row for an administrator who has no
--   government portal account.
--
-- STEP 1 -- create the auth users in Studio. Placeholders, to be rotated:
--
--     research.admin@fyp.invalid   -- PLACEHOLDER, change the address and the
--                                     password before real use
--     research.lead@fyp.invalid    -- PLACEHOLDER, same
--
--   Generate a 20+ character password for each. The `.invalid` TLD is reserved
--   by RFC 2606 and can never be a real domain, so a placeholder left in by
--   mistake cannot deliver mail to anyone.
--
-- STEP 2 -- grant the tiers, in the SQL editor, after this migration:
--
--     select public.research_bootstrap(
--       'research.admin@fyp.invalid', 'Research Administrator', 'super_admin');
--
--     select public.research_bootstrap(
--       'research.lead@fyp.invalid', 'Research Lead', 'research_lead');
--
-- After that the hierarchy is self-sustaining: the lead creates researchers on
-- screen 11 and sets their flags. There is no second use for this function
-- unless every lead and admin is locked out, which is also why it is left in
-- place rather than dropped.
-- ---------------------------------------------------------------------------
create or replace function public.research_bootstrap(
  p_email text,
  p_full_name text,
  p_tier text default 'research_lead'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
begin
  if p_tier not in ('super_admin', 'research_lead') then
    raise exception
      'research_bootstrap grants super_admin or research_lead only. A researcher '
      'is created by a lead on screen 11, with its flags set there -- got %.', p_tier;
  end if;

  select id into v_uid from auth.users where lower(email) = lower(p_email);

  if v_uid is null then
    raise exception
      'No auth user with email %. Create the user first (Studio > Authentication > '
      'Add user, with Auto Confirm ticked), then call this function again.', p_email;
  end if;

  -- Both bootstrappable tiers carry both capability flags, which the
  -- research_profiles_lead_flags constraint requires anyway. created_by stays
  -- null: these accounts were provisioned out of band, and claiming otherwise
  -- would put a false attribution in the audit trail.
  insert into public.research_profiles
    (id, full_name, tier, can_run_models, can_train_models, created_by, status)
  values (v_uid, p_full_name, p_tier, true, true, null, 'active')
  on conflict (id) do update
    set tier             = excluded.tier,
        can_run_models   = true,
        can_train_models = true,
        status           = 'active',
        full_name        = excluded.full_name;

  return v_uid;
end;
$$;

-- Only a database administrator in the SQL editor runs this. Leaving it
-- executable by `authenticated` would be a one-call self-promotion to research
-- super admin for any logged-in user -- exactly the escalation every policy in
-- the RLS migration exists to prevent.
revoke execute on function public.research_bootstrap(text, text, text)
  from public, anon, authenticated;

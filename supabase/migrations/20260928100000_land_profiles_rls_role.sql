-- land_profiles: grant its SELECT policy to `authenticated`, not `public`.
--
-- DRIFT, NOT A LEAK. The policy's USING clause has always filtered on
-- `f.owner_id = auth.uid()`, and for an anonymous caller auth.uid() is NULL,
-- so the EXISTS never matched and no row was ever returned. Nothing was
-- exposed. What was wrong is that the policy was CONSIDERED for anon at all:
-- every other table in this schema was moved to `to authenticated` by
-- 20260923210707_advisor_fixes.sql, and land_profiles was created two days
-- AFTER that migration ran, so it never received the same treatment.
--
-- Being explicit is the point. `to authenticated` states the intent in the
-- policy itself rather than leaving it implied by a subquery, and it stops
-- the planner evaluating the policy for a role that can never satisfy it.
--
-- ALTER POLICY rather than drop-and-recreate: it changes the role and leaves
-- the USING clause byte-identical, so there is no chance of mistranscribing
-- the ownership check while moving it.
alter policy "own land profile readable"
  on public.land_profiles
  to authenticated;

-- NOT CHANGED, and deliberately left for a separate decision: this policy
-- still calls a bare `auth.uid()` where every other policy in the schema uses
-- `(select auth.uid())`. The wrapped form is evaluated once per statement
-- instead of once per ROW -- see the reasoning in 20260923210707. It is a
-- performance difference only, with identical semantics, and it is out of
-- scope here.

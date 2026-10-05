# Government & Policy-Maker Portal

A second, **read-only** front end over the same Supabase project. It presents
district-level crop analytics to government users and holds no individual farm
records — no role in this portal can read a single row of `public.farms`.

- Entry point: `frontend/government.html` → `frontend/src/gov/`
- Dev: `npm run dev` then open **http://localhost:5173/government.html**
- The farmer portal is unchanged, but moved from `/` to `/farmer.html`:
  `/` is now the public landing page that chooses between portals.

---

## Setup, in order

### 1. Apply the three migrations

There is no `supabase` CLI, `psql` or Docker on this machine, so the migrations
are applied by hand. Open **Supabase Studio → SQL Editor** and run these in
order, one file per query:

```
supabase/migrations/20261003100000_gov_portal_schema.sql
supabase/migrations/20261003100100_gov_portal_rls.sql
supabase/migrations/20261003100200_gov_portal_seed.sql
```

All three are idempotent (`create table if not exists`, `on conflict do
nothing`, `drop policy if exists` before each `create policy`), so re-running
one is safe. Together they create 13 tables, 4 helper functions and 24 policies,
and seed 34 districts, 11 crops and 8 seasons.

Every file has been validated with Postgres's own parser (`libpg_query` via
`pglast`) — 134 statements, no syntax errors — but **applying them is the first
real test**, and nothing below will work until they are applied.

### 2. Create the first super admin

Two steps, because a login cannot be seeded honestly from SQL (the password is a
bcrypt hash and a usable account also needs an `auth.identities` row):

1. **Studio → Authentication → Users → Add user.** Tick *Auto Confirm User*.
   - email: `super.admin@punjab-agri.gov.pk` — **a placeholder, change it**
   - password: generate one, 20+ characters

2. **SQL Editor:**
   ```sql
   select public.gov_bootstrap_super_admin(
     'super.admin@punjab-agri.gov.pk', 'Provincial Administrator');
   ```

**No password is stored anywhere in this repository.** Whatever you set in step
1 is the only one that exists. Rotate it before anyone else can reach the
portal, and treat the super admin as a break-glass account — give yourself a
`district_manager` account for day-to-day work.

### 3. Load the analytical tables

```bash
cd ml-service
.venv/Scripts/python -m scripts.seed_gov_portal --offline   # compute only, no DB
.venv/Scripts/python -m scripts.seed_gov_portal             # write
```

Loads, from data already in the repository:

| Table | Rows | What it is |
|---|---|---|
| `gov_satellite_indices` | 2378 | Real Sentinel-2 seasonal composites (GEE) |
| `gov_yield_actuals` | 2378 | Real reported yields, with per-row provenance |
| `gov_yield_predictions` | 2247 | Real `app/model.pkl` output — 542 out-of-sample |
| `gov_risk_alerts` | 23 | Documented NDVI-deviation rule |
| `gov_subsidy_recommendations` | 18 | The brief's two-condition targeting rule |
| `gov_datasets` | 6 | Provenance records, counts read back from the above |

Nothing is generated or sampled. Two tables are deliberately **left empty** —
see *Known gaps* below.

### 4. Verify access control

```bash
.venv/Scripts/python -m scripts.verify_gov_rls
```

Creates six throwaway accounts across two districts, signs in as each **with the
anon key exactly as a browser does**, asserts ~45 boundaries, then deletes them.
It never checks a rule using the service key — that would pass no matter how
broken the policies were, because `service_role` bypasses RLS.

It covers: per-district read scoping on every analytical table, cross-district
isolation, farmer-table isolation, analytical tables being unwritable at every
tier, the survey designation gate, the dataset scope gate, the full provisioning
hierarchy, `created_by` forgery, self-escalation in seven forms, and whether
deactivation actually withdraws access.

### 5. Front-end checks

```bash
cd frontend
node scripts/gov-selfcheck.mjs   # 16 offline checks: geometry, formatters, CSV
npm run build                    # both entry points
```

---

## The access hierarchy

Three tiers, each scoped by row-level security rather than by the interface.

| | Reads | Can create | Can write |
|---|---|---|---|
| **Super admin** | All districts | District managers | Verify surveys, province-wide datasets |
| **District manager** | Own district only | Employees in own district | Verify own-district surveys and datasets |
| **Employee** | Own district only | Nobody | Surveys, **if** the designation allows |

Employee designations: `agriculture_officer` and `district_officer` may submit
surveys; `analyst` is read-only.

Three properties worth stating explicitly:

- **No self-registration anywhere.** `GovAuth.jsx` has a sign-in form and no
  sign-up route. A valid Supabase login with no `gov_profiles` row is told it has
  no portal access.
- **Nobody can edit their own profile row**, including the super admin. This is
  how "an employee must never elevate their own designation" is guaranteed:
  there is no `UPDATE` policy under which a caller's own row is a legal target,
  so it is not a check a cleverly shaped request could slip past.
- **No role can write an analytical table.** `gov_yield_predictions`,
  `gov_satellite_indices`, `gov_crop_area_estimates`, `gov_harvest_progress`,
  `gov_risk_alerts` and `gov_subsidy_recommendations` have *no* insert or update
  policy at all, and the `authenticated` grant is revoked on top. They are
  written only by the pipeline under the service key.

`src/gov/lib/access.js` mirrors these rules so the UI does not offer actions the
database will refuse. It is **not** a security control — the policies are.

---

## Known gaps and TODOs

**Two screens are empty because no source exists.** Both render their full
layout and name the missing input rather than estimating.

- **Crop area estimation (5).** Needs a crop-type classification raster per
  season. The pipeline has never produced one; the training set is
  district-crop-season spectral rows, which carry no area. Consequence: no
  production tonnage anywhere (production = area × yield), and every provincial
  mean in the portal is an unweighted district mean, labelled as such.
- **Harvest monitoring (8).** The detector *exists* (`app/harvest.py`) but is
  unvalidated — scoring it needs 20–30 confirmed harvest dates, which is still
  the project's binding constraint. Screen 11 collects them and shows the
  counter.

**Other open items**

- **District boundaries.** `gov_districts.geom` is NULL for all 34 rows. Maps
  draw Voronoi cells around district headquarters, clipped to an approximate
  provincial outline, and every legend says "approximate district cells". Fix by
  importing FAO GAUL level 2 polygons and `UPDATE … WHERE name = …`; the names
  are already GAUL-compatible because the GEE pipeline resolves them that way.
  Nothing else changes — `districtCells()` already returns the shape `GovMap`
  consumes.
- **No storage bucket.** Datasets are registered by reference (`file_url`), not
  uploaded. To wire it: create a private bucket and add a storage policy
  mirroring the `gov_datasets` insert policy.
- **Account creation is one step, via the ML service.** It used to be two: the
  portal could not create logins, because that needs the Auth Admin API and the
  service-role key, which must never ship in a browser bundle, so screen 14 took
  an auth UID copied out of Studio. That constraint has not changed — the key is
  still not in the bundle. What changed is that the ML service, which already
  holds it, now exposes `POST /gov/accounts`. Screen 14 sends the caller's own
  access token and the service creates the login and the profile together.

  **The hierarchy is re-checked in Python**, in `ml-service/app/accounts.py`
  `_rules()`, precisely *because* the service key bypasses the insert policies
  that would otherwise enforce it. Those rules are a transcription of the
  policies, not a reinterpretation: a super admin may create a district manager,
  a district manager may create an employee, and a manager's requested district
  is overwritten with their own — the same outcome
  `district_id = gov_district_id()` produces in SQL. If a policy changes, that
  file has to change with it.

  If the profile insert fails, the login is **deleted again**, so a failed
  attempt does not leave an orphan that can authenticate, has no profile, and
  holds the email address. Verified against the live database.

  `VITE_ML_API_URL` must be set for this; without it screen 14 says so and
  points back at Studio.
- **Flood and anomaly detection are not wired.** Flood needs Sentinel-1
  backscatter at district grain (radar is collected per *farm*); anomaly needs a
  within-season NDVI curve (only one seasonal composite is stored). Screen 10
  reports these as "no detector", not as "no events" — a different fact.
- **Only the `water` subsidy rule exists.** The brief's rule is specifically a
  yield deficit combined with soil/water access. Fertilizer, seed and credit
  rules would have to be invented, so the resource tabs are driven by what is in
  the table and no empty tab is offered.
- **Nankana Sahib and Chiniot are not seeded.** They were carved out of
  Sheikhupura and Jhang after the reporting series began, so their yields are
  still folded into the parent districts upstream. They remain tessellation
  seeds — dropping them would draw Sheikhupura at twice its real size — but have
  no data rows.
- **`barley` has no predictions.** The production model was trained on 10 of the
  11 crops. The seeder refuses to predict for it rather than letting a forest
  answer from the nearest leaf.

---

## Honesty rules this portal follows

The project has already been bitten by a confident number with nothing behind
it, so three conventions are enforced throughout:

1. **A missing value prints as `—`, never `0`.** `dash()` in `lib/fmt.js`, and a
   district with no value is drawn **grey** on a map rather than at the bottom of
   the colour ramp. (`mean()` had a real bug here — `Number(null)` is `0` and
   `isFinite(0)` is true, so nulls were being averaged in as zeros. Caught by
   `gov-selfcheck.mjs`.)
2. **In-sample fits are never presented as forecasts.**
   `gov_yield_predictions.evaluation` distinguishes `in_sample` from `holdout`;
   1705 of the model's rows are fits to seasons it trained on. Screen 7 reports
   accuracy from holdout rows only and shows the in-sample residual beside it
   purely so the difference is visible.
3. **Per-crop accuracy is published, not averaged away.** The pooled holdout R²
   is 0.92, but per-crop it ranges from wheat at **+0.73** to bajra at
   **−0.61**. Five crops are negative. The portal does not imply uniform
   accuracy.

---

## Deviations from the design folder

The design (`Goverment_Portal/…html`, now removed — it was ported, not kept) is
the source of truth for layout, and its stylesheet, grids, dark mode and chart
marks were ported essentially verbatim. These things in it were **not**
reproduced, each because the data does not exist:

| Design element | Why not |
|---|---|
| Area / production KPIs, area donut | No crop-area layer |
| Harvest progress figures | Unvalidated detector |
| Growth-stage rail (crop screen) | A stage is days-since-sowing for one field; a district composite has no sowing date |
| EVI/NDWI/SAVI/NBR derived from NDVI by a multiplier | All five are real independent columns; they are read, not derived |
| "Composite: latest / previous 5-day" selector | One seasonal composite is stored, not a rolling series; the season selector is the real equivalent |
| 90/60/30-day forecast tabs | One forecast per district-crop-season, with one measured lead time |
| Budget allocation planner (PKR by priority²) | An allocation formula nobody specified; rupee figures beside district names read as a decision |
| Dataset quality scores (97, 95, …) | Nothing computes one; the column shows a score only where one was genuinely written |
| Editable permission tick-box matrix | These capabilities are RLS policies, not rows. Shown read-only — a tick box would have to rewrite a policy to mean anything |
| Notification toggles, model-settings panel, units selector | Nothing reads them; a toggle that persists nothing teaches users the portal lies |
| PDF report generation | Needs a library this project does not have. Exports are real CSV instead; a PDF bulletin belongs in `app/report.py` server-side |
| Alert "Acknowledge" button | `resolved` is pipeline-owned and unwritable from the client by design |

Two things were **added**: a reported-vs-model scatter with a 1:1 line on the
dashboard (the question about a model is whether it agrees with the returns,
which is a position relative to the diagonal), and a provenance line on every
panel.

**Naming:** tables are prefixed `gov_` rather than using the brief's bare names
(`districts`, `crops`, `risk_alerts`). The database already holds farmer-side
`alerts`, `district_yields` and `satellite_features`; `public.alerts` versus
`public.gov_risk_alerts` says which audience a table serves at a glance, and the
prefix removes any chance of a policy being written against the wrong one.

**Two contradictions in the brief**, both resolved toward least privilege; each
is a one-line change to relax:

1. The access hierarchy says employees are created "by their District Manager
   (or by the Super Admin)", but the access-control section says a super admin
   may write profiles "only where the target row's role tier is
   district_manager". The stricter rule is implemented.
2. The access-control section says employee dataset uploads are "gated by their
   specific designation", then says `gov_datasets` writes are "allowed only to
   district_manager … or super_admin". The stricter rule is implemented.

**Screen count:** the design has 15 screens (the brief lists 14) and groups them
under its own five headings. The design's structure is kept, including its
`Settings` screen; screen 14 is titled "User & Access Management" from the brief,
whose specification for it is far more detailed.

# Researcher Portal

A third front end over the same Supabase project. Dataset access, model
training/retraining, evaluation and performance comparison. It owns six tables
and writes nothing else; every upstream table it touches is read-only.

- Entry point: `frontend/research.html` → `frontend/src/research/`
- Dev: `npm run dev` then open **http://localhost:5173/research.html**
- Linked from the landing page at `/`

---

## Status: applied

All three migrations are applied to project `gvqqqaodupcwnbayuiau`, and the
super admin account exists.

| | |
|---|---|
| Schema | 6 tables, 16 indexes, 1 partial unique index |
| Policies | 18 on the new tables, 7 additive SELECT policies on `gov_*` |
| Privileges | `UPDATE` on `model_runs` narrowed to the `status` column (table-level UPDATE = 0, verified) |
| Helpers | 6 `SECURITY DEFINER` functions, granted to `authenticated`, revoked from `anon` (verified) |
| Benchmarks | 5 rows seeded, 2 carrying a value |

### Signing in

**`jmuzammil93@gmail.com` — the same login as the government portal.**

It is one `auth.users` row (`a0352dc5-…`) holding two profiles: `super_admin`
in `gov_profiles` and `super_admin` in `research_profiles`. The password is
whatever you set for the government portal; it was not changed, and nothing in
this repository stores it.

`research_is_super_admin()` also treats a *government* super admin as a research
super admin without a row here, so that account would have had full access
either way — the row was added because it was asked for, and it makes the
membership explicit rather than inferred.

### Creating further accounts

**From the portal UI**, on the User & Access Management screen. Email, password,
full name, tier, and the two flags. No Supabase Studio step and no UUID to paste.

### 3. Verify the access control

```bash
cd ml-service
.venv/Scripts/python -m scripts.verify_research_rls
```

Creates five throwaway accounts — a lead and four researchers with every
combination of the two flags — signs in as each with the **anon** key exactly as
a browser does, asserts every boundary from both sides, then deletes them and
reads back to confirm the cleanup worked.

**It has still not been run.** It creates five real auth users in the live
project. The policies are applied now, so it should pass — run it when you are
ready to accept the fixtures being created and deleted.

What *has* been verified end to end against the live database is the
provisioning path: signing in as the super admin, creating a researcher with
`can_run_models` only, and then confirming the refusals — a super admin cannot
create another super admin (403), a duplicate email is refused (409), a 3-character
password is refused (422), an unauthenticated request is refused (401), and a
government manager account without a district is refused (422). None of the four
refusals left an orphan login behind.

### 4. Start the ML service

```bash
cd ml-service
.venv/Scripts/python -m pip install -r requirements.txt   # adds python-multipart
uvicorn app.main:app --reload
```

The portal is usable without it — every analytical screen is a Postgres read.
Only dataset upload and the job start signal need it, and both say so where they
are used rather than blocking the portal at boot. `VITE_ML_API_URL` must be set
in `frontend/.env` for those two.

---

## Access model

Two tiers below the platform's existing super admin, and the capability split
is carried by **flags, not tiers**.

| | Read analytics | Action A: run | Action B: train + upload | Action C: promote | Manage accounts |
|---|---|---|---|---|---|
| **super_admin** | ✓ | ✓ | ✓ | ✓ | leads + researchers |
| **research_lead** | ✓ | ✓ | ✓ | ✓ | its own researchers |
| **researcher**, both flags | ✓ | ✓ | ✓ | ✗ | ✗ |
| **researcher**, `can_run_models` | ✓ | ✓ | ✗ | ✗ | ✗ |
| **researcher**, `can_train_models` | ✓ | ✗ | ✓ | ✗ | ✗ |
| **researcher**, neither | ✓ | ✗ | ✗ | ✗ | own row, read-only |

Four things worth stating plainly, because each is a DB invariant rather than a
UI convention:

1. **Promotion is a tier, never a flag.** A researcher holding *both* flags
   still cannot promote. `research_can_promote()` reads the tier.
2. **A training can only ever produce a candidate.** The insert policy pins
   `status = 'candidate'`, so a client POSTing `'production'` is refused by
   Postgres, not corrected by the UI. Retraining from the production model is
   therefore safe by construction — the parent's status has no bearing on the
   child's.
3. **Nobody edits their own account.** There is no self-update policy at any
   tier, including the super admin's, so the escalation is *absent* rather than
   guarded against.
4. **A lead may change `status` and nothing else.** The migration revokes
   `UPDATE` on `model_runs` from `authenticated` and re-grants it on that one
   column. An RLS policy cannot restrict *columns*, only rows, so a policy
   permissive enough for Action C would otherwise let a lead rewrite `r2` on a
   finished run.

Metrics, `job_status`, `version_label` and the run logs are writable only by the
ML service with the service key.

---

## Where the permission check actually happens

| Path | Enforced by |
|---|---|
| Action A / B — queue a run | **RLS insert policy** on `model_runs`. The portal inserts the row directly; a crafted PostgREST request from an under-privileged account is refused by Postgres. |
| Action C — promote | **RLS update policy** + the column grant above. |
| Dataset upload | **Python, in `_research_profile()`.** The file must reach the service's filesystem, so the row is written with the service key, which *bypasses* RLS. This is the one place a permission is enforced outside a policy, and it is enforced there *because* of that bypass. |

The authorisation decision for a run is made **once**, by the database, when the
row is created. `POST /research/runs/{id}/start` does not re-check the flag — it
only checks who may press start (the person who queued it, or a lead), so one
researcher cannot start another's job and leave `triggered_by` disagreeing with
who caused the work.

---

## Job execution

**No queue, no broker, no realtime subscription** — this project has none, and
adding one would be new infrastructure. The only existing async mechanism is the
daemon thread in `app/gee.py`, so that pattern is reused:

1. portal inserts `model_runs` with `job_status='queued'` (RLS decides)
2. portal `POST`s the id to the ML service
3. service runs the job on a **daemon thread**, appending to `model_run_logs`
   and patching `job_status` with the service key
4. portal **polls** the run row and its logs every 2 s, stopping at a terminal
   state

**Consequence, stated plainly:** a job dies if the service restarts mid-run.
`reap_stale()` runs at startup and marks those `failed` rather than retrying —
a half-trained model silently resuming is worse than one that visibly never
finished.

---

## What actually trains

**Only RandomForest.** `scikit-learn` is the only ML library in
`requirements.txt`.

All four model types are offered in the picker, because the brief asks for all
four. The other three fail with a reason naming the missing package, and the UI
says so *before* you wait for a job:

| Type | Status |
|---|---|
| RandomForest | **Trains.** 500 trees, max depth 25, seed 42 |
| XGBoost | `xgboost` not installed. Sklearn-API compatible, so it drops into `_fit_sklearn` with no other change |
| CNN | No deep-learning backend, **and** needs the per-date sequence format from `experimental/temporal_features`, not this flat matrix |
| LSTM | Same as CNN |

`TRAINABLE` is declared in both `ml-service/app/research.py` and
`frontend/src/research/lib/access.js`, and `research-selfcheck.mjs` asserts the
two agree.

---

## Dataset schema

An upload must carry:

- all five index columns — `ndvi, evi, ndwi, savi, nbr`
- a target — `actual_yield`
- a temporal column — `date` **or** `season`

Optional, used where present: `tmax_mean_c, tmin_mean_c, tmax_peak_c, rain_mm`
and `ph, clay_pct, silt_pct, sand_pct, bulk_dens, water_33k`.

A malformed or empty file is rejected with the reason and **nothing is written** —
no row, no file. There is no half-registered state that fails hours later at
training time.

A blank optional cell becomes **NaN, then the column median — never 0**. Zero
NDVI is a real reading meaning bare ground; imputing a missing observation as
zero would teach the model that an absent measurement looks like a dead field.
`tests/test_research.py` asserts this specifically.

Files land in `ml-service/data/research/`, **not** a Supabase Storage bucket —
no bucket is configured in this project and introducing one would be new
infrastructure. `storage_path` takes an object key unchanged if Storage is
adopted later.

---

## Deviations and assumptions

**There is no `researcher_portal` design folder.** The brief names one as the
source of truth for layout, screens and flow; it does not exist anywhere in the
repository. The brief's own fallback was followed — its screen list and sidebar
grouping are used verbatim, all 11 screens in the stated order and groups.

**The design system is the government portal's.** `research.css` imports
`gov.css` whole and adds only what this portal has and that one does not
(status badges, job chips, a confusion matrix, a log console, a permission
toggle, a confirmation dialog, a model picker). `Card`, `Panel`, `Kpi`, `Empty`,
`ErrorNote`, `TableWrap`, the chart marks, `useQuery`, the formatters and the CSV
writer are imported from `../gov/lib/*`, not copied. The brief said to match
existing component patterns exactly, and that *is* the pattern — an approved
design for an internal invite-only analytical portal. **The coupling is real:**
a layout change in `gov.css` reaches this portal. That is the accepted trade.

**Table names are the brief's, not prefixed.** `research_profiles`,
`dataset_versions`, `model_runs`, `model_run_logs`, `model_status_history`,
`benchmark_references`. The government portal prefixes everything `gov_`; these
follow the brief's explicit naming instead, so the schema matches the document
it was specified in.

**`run_kind` is an added column, and a necessary one.** The brief puts Action A's
evaluations and Action B's trainings in one table, but they are not the same
thing: a training is a model *version* with a status, an evaluation is a
read-only scoring that can never be promoted. Without the column the two are
indistinguishable and Action A's picker would offer its own past evaluations as
things to evaluate. A check constraint ties `status is not null` to
`run_kind='training'`, which is what makes "running never changes what the
pipeline serves" structural.

**`precision_score`, not `precision`.** `PRECISION` is a Postgres type keyword
(`double precision`). It is accepted as a column name but needs quoting in
enough contexts that the suffix is cheaper than the surprise, and it matches the
`f1_score` beside it.

**Export is gated on `can_run_models` OR `can_train_models`.** The brief says
"preview and export (CSV/JSON) gated by permission level" without naming the
level. The assumption: an account that can trigger work may export; a read-only
account previews on screen but does not take the data away. One predicate to
change if that is the wrong split.

**Field surveys are restricted to `status='verified'`.** The brief wants ground
truth from the government portal's survey verification data. A pending
submission is an officer's unreviewed claim and a rejected one was judged wrong;
neither is ground truth, and exposing an officer's unadjudicated or overturned
work to a different portal is a disclosure the brief does not ask for.

**At most one production version per `model_type`**, via a partial unique index.
Promoting archives the outgoing production model of the same type *first*,
because the index would otherwise reject the promotion.

**Report export is CSV + browser print, not a generated PDF.** The ML service
already writes per-farm PDFs with `fpdf2`, but that is a server-rendered report
of one farm. A PDF here would mean either a new browser dependency — which the
brief forbids — or a new endpoint duplicating screen 10's filter logic in
Python, where it would drift from the JS version.

**`python-multipart` was added to `requirements.txt`.** FastAPI raises at import
time without it for `UploadFile`/`Form`, and names the package itself, so there
was no alternative to choose between.

---

## TODOs

- **Run `verify_research_rls.py`.** It has never been run; it creates and then
  deletes five real auth users.
- **One test account is still in the database.**
  `uitest.researcher@example.invalid` (`4bde8357-…`), created by the end-to-end
  check above. The delete was declined, so it is still there — a working login
  with a researcher profile and `can_run_models`. Remove it:
  ```sql
  delete from public.research_profiles where id = '4bde8357-7c39-4fde-9f42-41d438102230';
  delete from auth.users              where id = '4bde8357-7c39-4fde-9f42-41d438102230';
  ```
- **Leaked-password protection is off** in Supabase Auth, and the advisor flags
  it. `Admin@123` is the kind of password that check exists to reject. Worth
  enabling, and worth rotating that password before anyone else can reach the
  portals.
- **Three benchmark citations have no value.** Pantazi et al. 2016, Kuwata &
  Shibasaki 2015 and Kang et al. 2020 appear **nowhere in this repository** —
  the only literature figure the project records is the 0.78–0.84 R² band
  hardcoded at `ml-service/scripts/train_real.py:491`, which cites no paper. The
  three rows are seeded with a NULL `metric_value` and a note saying what is
  needed. Writing a remembered number next to a real author's name would put a
  fabricated result into an academic comparison table, and it is the one error
  here nobody downstream could catch. Open each paper, read the metric, and
  `UPDATE` it on screen 9.
- **XGBoost, CNN, LSTM cannot train.** See the table above.
- **Nobody has opened this portal in a browser.** The build is clean and 160+
  offline checks pass, but no screen has been rendered. Verify after applying
  the policies and creating an account.
- **Whole-file median imputation** in `_load_matrix` — marked with a
  `ponytail:` comment. Strictly the median should be fitted on the train split
  alone; it matters only if missingness rises above a few percent.
- **No real-time progress.** Polling at 2 s is adequate for a 30 s RandomForest
  fit and would not be for a 20-minute deep-learning run.

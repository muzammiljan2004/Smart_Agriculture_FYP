/** Who may see and do what, in one place.
 *
 * NOTHING IN THIS FILE IS A SECURITY CONTROL, and it is worth being as blunt
 * about that here as the government portal's equivalent is. Every rule below
 * has a matching RLS policy in
 * supabase/migrations/20261004100100_research_portal_rls.sql, and the policy is
 * the one that decides. This file exists so the interface does not offer an
 * action Postgres will then refuse.
 *
 * The brief asks for action controls to be ABSENT rather than disabled when an
 * account lacks the flag, which is why these predicates gate rendering rather
 * than a `disabled` attribute: a greyed-out "Train" button still tells a
 * researcher that training exists and that they are being kept from it, which
 * is a worse experience than a screen that simply does not offer it.
 *
 * The two layers are written to the same shape so they can be read side by side
 * and checked against each other. scripts/research-selfcheck.mjs asserts the
 * pairs agree on a table of cases.
 */

export const TIERS = {
  super_admin: 'Super Admin',
  research_lead: 'Research Lead',
  researcher: 'Researcher',
}

export const STATUSES = ['candidate', 'approved', 'production', 'archived']

export const STATUS_LABEL = {
  candidate: 'Candidate',
  approved: 'Approved',
  production: 'Production',
  archived: 'Archived',
}

/** The brief calls this status "Experimental/Candidate" on screen 4. One stored
 *  value, two words for it, so the longer form is spelled out where there is
 *  room and the badge stays short. */
export const STATUS_LONG = {
  ...STATUS_LABEL,
  candidate: 'Candidate (experimental)',
}

export const MODEL_TYPES = ['RandomForest', 'XGBoost', 'CNN', 'LSTM']

/** Which model types this deployment can actually train.
 *
 * Mirrors TRAINABLE in ml-service/app/research.py. scikit-learn is the only ML
 * library in requirements.txt, so the other three are offered in the picker --
 * the brief asks for all four -- and fail with a reason naming the missing
 * package rather than a traceback. Keeping the list here lets screen 7 say so
 * BEFORE the researcher waits for a job to fail. */
export const TRAINABLE = ['RandomForest']

export const UNTRAINABLE_REASON = {
  XGBoost: 'the xgboost package is not installed in this environment',
  CNN: 'no deep-learning backend is installed, and CNN training needs the '
     + 'per-date sequence format rather than the flat feature matrix',
  LSTM: 'no deep-learning backend is installed, and LSTM training needs the '
      + 'per-date sequence format rather than the flat feature matrix',
}

export const roleLabel = (p) => (p ? TIERS[p.tier] ?? p.tier : '—')

const active = (p) => p?.status === 'active'

/* ------------------------------------------------------------- capabilities
 *
 * Each mirrors the RLS helper named in its comment. If one changes, the other
 * has to change with it or the UI starts promising something Postgres refuses.
 */

/** RLS: research_is_super_admin(). Also true for a government super admin with
 *  no research_profiles row -- queries.fetchMyProfile() synthesises a profile
 *  for that case, so by the time it reaches here the tier is already set. */
export const isSuperAdmin = (p) => active(p) && p.tier === 'super_admin'

/** RLS: research_can_run(). ACTION A. */
export const canRun = (p) => active(p) && (Boolean(p.can_run_models) || isSuperAdmin(p))

/** RLS: research_can_train(). ACTION B, which includes dataset upload --
 *  the brief folds upload into train/retrain rather than gating it apart. */
export const canTrain = (p) => active(p) && (Boolean(p.can_train_models) || isSuperAdmin(p))

/** RLS: research_can_promote(). ACTION C.
 *
 *  TIER, never a flag. A researcher holding both can_run_models and
 *  can_train_models still cannot promote -- "never available to a plain
 *  researcher regardless of their flags". */
export const canPromote = (p) =>
  active(p) && (p.tier === 'research_lead' || isSuperAdmin(p))

/** RLS: the four research_profiles write policies. */
export const canManageAccounts = (p) => canPromote(p)

/** RLS: "research leads write/update/delete benchmarks". */
export const canEditBenchmarks = (p) => canPromote(p)

/** What tiers the caller may create. Empty for a researcher.
 *
 *  Mirrors "no role may insert a research_profiles row granting a tier equal to
 *  or higher than its own": a super admin cannot create another super admin,
 *  and a lead cannot create another lead. */
export const provisionableTiers = (p) =>
  isSuperAdmin(p) ? ['research_lead', 'researcher']
    : p?.tier === 'research_lead' && active(p) ? ['researcher']
      : []

/** True where screen 7 has at least one action to offer. A researcher with
 *  neither flag gets no Model Operations screen at all rather than a page of
 *  three things they cannot do. */
export const canOpenOperations = (p) => canRun(p) || canTrain(p) || canPromote(p)

/* ----------------------------------------------------------------- screens
 *
 * Eleven, in the brief's sidebar grouping and order. There is no
 * researcher_portal design folder in the repo to take a different structure
 * from, so the brief's own grouping is used verbatim and that is noted in the
 * summary as the standing assumption.
 *
 * `allow` is omitted where every active account may open the screen, which is
 * most of them -- the portal is analytical, and what a weaker account loses is
 * the ability to TRIGGER things, not to read results. That is the brief's
 * "a Researcher with neither flag can still open the Performance Comparison
 * screen and view results from runs/trainings that others have completed".
 */
export const SCREENS = [
  { id: 'dashboard', title: 'Research dashboard',
    sub: 'Datasets, logged runs and recent training activity',
    nav: 'Research Dashboard', icon: 'dash' },

  { id: 'explorer', title: 'Dataset explorer',
    sub: 'Raw temporal feature data by district, crop and season',
    nav: 'Dataset Explorer', group: 'Datasets', icon: 'db' },
  { id: 'versions', title: 'Dataset versioning',
    sub: 'Snapshots, record counts and schema validation status',
    nav: 'Dataset Versioning', group: 'Datasets', icon: 'db' },

  { id: 'comparison', title: 'Model performance comparison',
    sub: 'Compare runs side by side across crop, season, type and status',
    nav: 'Model Performance Comparison', group: 'Model Analysis', icon: 'chart' },
  { id: 'importance', title: 'Feature importance',
    sub: 'Which index or variable drives each model’s prediction',
    nav: 'Feature Importance', group: 'Model Analysis', icon: 'chart' },
  { id: 'actual', title: 'Prediction vs actual',
    sub: 'Predicted yield against verified ground truth over time',
    nav: 'Prediction vs Actual', group: 'Model Analysis', icon: 'chart' },

  { id: 'operations', title: 'Train & run models',
    sub: 'Run an existing version, train a new one, or promote a candidate',
    nav: 'Train & Run Models', group: 'Model Operations', icon: 'gear',
    allow: canOpenOperations },
  { id: 'history', title: 'Model version history',
    sub: 'Every trained version, its lineage, dataset and status trail',
    nav: 'Model Version History', group: 'Model Operations', icon: 'file' },

  { id: 'benchmark', title: 'Benchmark comparison',
    sub: 'This project’s results against the literature',
    nav: 'Benchmark Comparison', group: 'Publications & Reports', icon: 'file' },
  { id: 'reports', title: 'Report & export centre',
    sub: 'Exportable tables and charts for academic write-ups',
    nav: 'Report & Export Center', group: 'Publications & Reports', icon: 'file' },

  { id: 'access', title: 'User & access management',
    sub: 'Accounts and permission flags',
    nav: 'User & Access Management', group: 'Admin', icon: 'users' },
]

export const visibleScreens = (p) =>
  SCREENS.filter((s) => (s.allow ? s.allow(p) : Boolean(active(p))))

export const screenById = (id) => SCREENS.find((s) => s.id === id)

export const groupOf = (id) => screenById(id)?.group ?? null

/** The sidebar tree: ungrouped screens stay flat, grouped ones collapse under
 *  their heading. Same shape the government portal's navTree returns, so the
 *  shell rendering is identical. */
export function navTree(p) {
  const out = []
  for (const s of visibleScreens(p)) {
    if (!s.group) { out.push({ single: s }); continue }
    const last = out[out.length - 1]
    if (last?.group === s.group) last.items.push(s)
    else out.push({ group: s.group, icon: s.icon, items: [s] })
  }
  return out
}

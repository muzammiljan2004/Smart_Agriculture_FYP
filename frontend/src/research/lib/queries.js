/** Every read and write the researcher portal makes.
 *
 * All of it goes through the ordinary anon-key client in src/supabase.js, with
 * the caller's own session, so RLS applies to every row returned here. There is
 * no service-role key in this bundle: what a researcher can see and do is
 * decided in Postgres, and this file cannot widen it. A write here that fails
 * with "new row violates row-level security policy" is the policy working, and
 * the screens surface that message rather than hiding it.
 *
 * TWO WRITE PATHS, and the split is the portal's whole security story:
 *
 *   straight to Postgres   the model_runs row for Action A / B, the status
 *                          change for Action C, account provisioning,
 *                          benchmark edits. RLS decides.
 *   via the ML service     the dataset upload (the file has to reach the
 *                          service's filesystem) and the start signal for a
 *                          queued job.
 */
import { supabase } from '../../supabase'

const API = import.meta.env.VITE_ML_API_URL

/** PostgREST caps an unbounded select at 1000 rows and does NOT say it
 *  truncated. gov_satellite_indices holds ~2400 rows and model_runs will grow
 *  without bound, so every select that can exceed the cap pages explicitly.
 *  This project has been bitten by the silent cap before. */
const PAGE = 1000

async function all(build) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    out.push(...(data || []))
    if (!data || data.length < PAGE) return out
  }
}

const one = async (q) => {
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data
}

/* ------------------------------------------------------------- dimensions */

export const fetchDistricts = () =>
  one(supabase.from('gov_districts').select('id,name,province').order('name'))

export const fetchCrops = () =>
  one(supabase.from('gov_crops').select('id,name,category,season').order('name'))

export const fetchSeasons = () =>
  one(supabase.from('gov_seasons').select('id,label,start_date,end_date').order('label'))

/** The caller's own profile.
 *
 * TWO WAYS TO BE A MEMBER OF THIS PORTAL, and this is where they are reconciled.
 *
 * A research_profiles row is the normal case. But research_is_super_admin() in
 * the RLS migration also treats a GOVERNMENT super admin as a research super
 * admin -- the brief's "shared with/mirrored from the government portal's tier"
 * -- and such a person may have no row here at all. Postgres would let them
 * read and promote everything while this function returned null, and the shell
 * would show them "no access" over a portal they actually administer.
 *
 * So when there is no row, gov_profiles is checked for an active super admin
 * and a profile is SYNTHESISED with `mirrored: true`. Screen 11 uses that flag
 * to explain why their account has no editable row of its own.
 *
 * Returns null for a signed-in user who is neither. That is a real state, not
 * an error: the portal is invite-only.
 */
export async function fetchMyProfile() {
  const { data: session } = await supabase.auth.getSession()
  const user = session.session?.user
  if (!user) return null

  const { data, error } = await supabase
    .from('research_profiles')
    .select('id,full_name,tier,can_run_models,can_train_models,status,created_by,created_at')
    .eq('id', user.id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (data) return { ...data, email: user.email, mirrored: false }

  const { data: gov, error: govErr } = await supabase
    .from('gov_profiles')
    .select('id,full_name,tier,status')
    .eq('id', user.id)
    .maybeSingle()
  // A researcher with no gov_profiles row cannot read that table either, so an
  // error here is the expected outcome for most accounts, not a failure.
  if (govErr) return null
  if (gov?.status === 'active' && gov.tier === 'super_admin') {
    return {
      id: gov.id,
      full_name: gov.full_name,
      tier: 'super_admin',
      can_run_models: true,
      can_train_models: true,
      status: 'active',
      created_by: null,
      created_at: null,
      email: user.email,
      mirrored: true,
    }
  }
  return null
}

/* --------------------------------------------------------------- datasets */

export const fetchDatasetVersions = () =>
  one(supabase
    .from('dataset_versions')
    .select('id,description,storage_path,record_count,schema_validated,'
          + 'validation_notes,uploaded_by,created_at,'
          + 'research_profiles!dataset_versions_uploaded_by_fkey(full_name)')
    .order('created_at', { ascending: false }))

/** Screen 2's raw temporal data. Paged, because this table exceeds the
 *  PostgREST cap. Filters are applied server-side so a district-and-crop view
 *  is one small response rather than 2400 rows filtered in the browser. */
export function fetchSatelliteIndices({ districtId, cropId, seasonId } = {}) {
  return all(() => {
    let q = supabase
      .from('gov_satellite_indices')
      .select('id,district_id,crop_id,season_id,date,ndvi,evi,ndwi,savi,nbr,source,'
            + 'gov_districts(name),gov_crops(name),gov_seasons(label)')
      .order('date')
    if (districtId) q = q.eq('district_id', districtId)
    if (cropId) q = q.eq('crop_id', cropId)
    if (seasonId) q = q.eq('season_id', seasonId)
    return q
  })
}

/** Upload a dataset through the ML service, which validates it, writes the
 *  file and creates the dataset_versions row with the service key.
 *
 *  The service returns 422 with the validator's own message for a malformed
 *  file and writes NOTHING in that case -- no row, no file. That message is
 *  rethrown verbatim so the screen can show the researcher which column is
 *  missing, which is the brief's "clear UI error, never a silent failure". */
export async function uploadDataset(file, description) {
  const { data: s } = await supabase.auth.getSession()
  const token = s.session?.access_token
  if (!token) throw new Error('Your session has expired. Sign in again.')
  if (!API) throw new Error('VITE_ML_API_URL is not set in this build, so uploads cannot reach the ML service.')

  const body = new FormData()
  body.append('file', file)
  body.append('description', description)

  const res = await fetch(`${API}/research/datasets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    // FastAPI puts the message in `detail`; a 500 may have neither.
    throw new Error(json.detail || `Upload failed (HTTP ${res.status}).`)
  }
  return json
}

/* -------------------------------------------------------------- model runs */

/** Every run and training, newest first. Screen 4 compares across all of them,
 *  so no status filter is applied here -- the brief is explicit that
 *  non-production models are never hidden by default. */
export const fetchRuns = () =>
  all(() => supabase
    .from('model_runs')
    .select('id,run_kind,model_type,version_label,crop_id,district_id,season_id,'
          + 'dataset_version_id,run_config,models_selected,parent_model_run_id,'
          + 'triggered_by,job_status,started_at,completed_at,status,output_type,'
          + 'r2,rmse,mae,accuracy,precision_score,recall,f1_score,confusion_matrix,'
          + 'error_message,created_at,'
          + 'gov_crops(name),gov_districts(name),gov_seasons(label),'
          + 'research_profiles!model_runs_triggered_by_fkey(full_name)')
    .order('created_at', { ascending: false }))

/** Model VERSIONS only -- the things Action A can evaluate and Action C can
 *  promote. run_kind='training' is the filter that separates a version from a
 *  past evaluation of one. */
export const fetchVersions = () =>
  all(() => supabase
    .from('model_runs')
    .select('id,model_type,version_label,status,job_status,output_type,r2,rmse,mae,'
          + 'accuracy,f1_score,dataset_version_id,parent_model_run_id,run_config,'
          + 'completed_at,created_at,triggered_by,'
          + 'gov_crops(name),research_profiles!model_runs_triggered_by_fkey(full_name)')
    .eq('run_kind', 'training')
    .order('created_at', { ascending: false }))

export const fetchRun = (id) =>
  one(supabase.from('model_runs').select('*').eq('id', id).maybeSingle())

export const fetchRunLogs = (id) =>
  one(supabase
    .from('model_run_logs')
    .select('id,log_line,logged_at')
    .eq('model_run_id', id)
    .order('logged_at', { ascending: true })
    .limit(400))

export const fetchStatusHistory = () =>
  all(() => supabase
    .from('model_status_history')
    .select('id,model_run_id,old_status,new_status,changed_at,changed_by,'
          + 'research_profiles!model_status_history_changed_by_fkey(full_name)')
    .order('changed_at', { ascending: false }))

/** ACTION A — queue an evaluation of one or more existing versions.
 *
 * Inserts the row, then asks the service to start it. The insert is the
 * authorisation point: a researcher without can_run_models is refused here by
 * Postgres, which is why `start` does not re-check the flag.
 *
 * Every pinned field below is also pinned by the policy's WITH CHECK. Sending
 * them is not what makes them true -- it just keeps the request from being
 * rejected for disagreeing with the policy.
 */
export async function queueEvaluation({ me, modelIds, datasetVersionId, cropId,
                                        districtId, seasonId, outputType }) {
  const row = await one(supabase.from('model_runs').insert({
    run_kind: 'evaluation',
    // The evaluation itself has no single model type; record the types scored
    // so the row reads sensibly in a list. First selected wins the column.
    model_type: modelIds.modelType,
    models_selected: modelIds.ids,
    dataset_version_id: datasetVersionId,
    crop_id: cropId || null,
    district_id: districtId || null,
    season_id: seasonId || null,
    run_config: { output_type: outputType || 'regression' },
    triggered_by: me.id,
    job_status: 'queued',
    status: null,
  }).select('id').single())
  return handOff(row.id)
}

/** ACTION B — queue a training or retraining.
 *
 * `status: 'candidate'` is sent because the policy requires exactly that. A
 * client that sent 'production' would be refused -- which is what makes "always
 * produces a candidate, regardless of what it was trained from" structural
 * rather than a convention this file happens to follow.
 */
export async function queueTraining({ me, modelType, datasetVersionId, parentId,
                                      cropId, districtId, seasonId, config }) {
  const row = await one(supabase.from('model_runs').insert({
    run_kind: 'training',
    model_type: modelType,
    dataset_version_id: datasetVersionId,
    parent_model_run_id: parentId || null,
    crop_id: cropId || null,
    district_id: districtId || null,
    season_id: seasonId || null,
    run_config: config || {},
    triggered_by: me.id,
    job_status: 'queued',
    status: 'candidate',
  }).select('id').single())
  return handOff(row.id)
}

/** Hand a queued run to the ML service, without losing the row if that fails.
 *
 * The insert and the start are two separate systems, and the second one can be
 * down while the first succeeded. Letting startRun's error propagate bare threw
 * the new row's id away with it: a real queued run existed in the database that
 * no screen was pointing at, and the "send start signal again" recovery path
 * needs exactly that id. So the id is carried on the error.
 */
async function handOff(runId) {
  try {
    await startRun(runId)
  } catch (e) {
    const err = new Error(e.message || String(e))
    err.runId = runId
    throw err
  }
  return runId
}

/** Hand a queued run to the ML service. */
export async function startRun(runId) {
  const { data: s } = await supabase.auth.getSession()
  const token = s.session?.access_token
  if (!token) throw new Error('Your session has expired. Sign in again.')
  if (!API) {
    throw new Error(
      'VITE_ML_API_URL is not set in this build, so the job was queued but '
      + 'cannot be started. Set it and press Start again on the run.'
    )
  }
  const res = await fetch(`${API}/research/runs/${runId}/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.detail || `Could not start the run (HTTP ${res.status}).`)
  return json
}

/** ACTION C — change a version's status.
 *
 * Only `status` is sent, and only `status` CAN be sent: the migration revokes
 * UPDATE on model_runs from `authenticated` and re-grants it on that one
 * column. A research lead cannot rewrite a metric even by crafting the request.
 *
 * Promoting to production archives the outgoing production model of the same
 * type FIRST. Two reasons that order matters: a partial unique index forbids two
 * production rows of one type, so promoting before archiving would be rejected;
 * and "the previously-production model becomes archived, still fully viewable
 * and re-runnable" is the brief's required behaviour, not a side effect.
 */
export async function setModelStatus(run, next) {
  if (next === 'production') {
    const current = await one(supabase
      .from('model_runs')
      .select('id')
      .eq('run_kind', 'training')
      .eq('model_type', run.model_type)
      .eq('status', 'production')
      .neq('id', run.id))
    for (const prev of current || []) {
      const { error } = await supabase
        .from('model_runs').update({ status: 'archived' }).eq('id', prev.id)
      if (error) {
        throw new Error(
          `Could not archive the outgoing production ${run.model_type} `
          + `(${prev.id.slice(0, 8)}): ${error.message}. Nothing was promoted.`
        )
      }
    }
  }
  const { error } = await supabase
    .from('model_runs').update({ status: next }).eq('id', run.id)
  if (error) throw new Error(error.message)
  // The audit row is written by the research_status_audit trigger, not here --
  // so a promotion issued straight to PostgREST is recorded too.
}

/* ------------------------------------------------------- prediction vs actual
 *
 * Screen 6 needs both sides. Assembled from three selects rather than one join:
 * PostgREST cannot full-outer-join, and an inner join would silently DROP a
 * district-season that has a prediction but no verified survey -- which is most
 * of them, and exactly the gap the screen exists to show.
 */
export async function fetchPredictionVsActual({ cropId, seasonId }) {
  const scope = (q) => {
    let r = q
    if (cropId) r = r.eq('crop_id', cropId)
    if (seasonId) r = r.eq('season_id', seasonId)
    return r
  }

  const [preds, actuals, surveys] = await Promise.all([
    all(() => scope(supabase
      .from('gov_yield_predictions')
      .select('district_id,crop_id,season_id,predicted_yield,evaluation,model_used,'
            + 'gov_districts(name),gov_seasons(label)')
      .order('season_id'))),
    all(() => scope(supabase
      .from('gov_yield_actuals')
      // yield_t_ha, not actual_yield -- the CSV upload column is named
      // actual_yield and this table is not. They are different contracts.
      .select('district_id,crop_id,season_id,yield_t_ha,source,'
            + 'gov_districts(name),gov_seasons(label)'))),
    // Verified only -- the RLS policy restricts this table to status='verified'
    // anyway, so the filter here is documentation rather than enforcement.
    all(() => scope(supabase
      .from('gov_field_surveys')
      .select('district_id,crop_id,season_id,verified_yield,survey_type,reviewed_at')
      .eq('status', 'verified')
      .not('verified_yield', 'is', null))),
  ])

  const key = (r) => `${r.district_id}|${r.crop_id}|${r.season_id}`
  const byKey = new Map()
  const slot = (r) => {
    const k = key(r)
    if (!byKey.has(k)) {
      byKey.set(k, {
        key: k,
        district: r.gov_districts?.name ?? null,
        season: r.gov_seasons?.label ?? null,
        district_id: r.district_id,
        season_id: r.season_id,
        predicted: null, actual: null, survey: null,
        evaluation: null, model_used: null, source: null,
      })
    }
    return byKey.get(k)
  }

  for (const p of preds) {
    const s = slot(p)
    s.predicted = p.predicted_yield
    s.evaluation = p.evaluation
    s.model_used = p.model_used
  }
  for (const a of actuals) {
    const s = slot(a)
    s.actual = a.yield_t_ha
    s.source = a.source
  }
  // Several surveys can cover one district-season. Averaged rather than
  // last-wins: two officers' yield cuts are two measurements of one thing.
  const agg = new Map()
  for (const v of surveys) {
    const k = key(v)
    const cur = agg.get(k) || { sum: 0, n: 0 }
    cur.sum += Number(v.verified_yield)
    cur.n += 1
    agg.set(k, cur)
    const s = slot(v)
    s.survey = cur.sum / cur.n
    s.survey_n = cur.n
  }

  return [...byKey.values()]
}

/* ------------------------------------------------------------- benchmarks */

export const fetchBenchmarks = () =>
  one(supabase
    .from('benchmark_references')
    .select('id,citation,metric_type,metric_value,crop_type,notes,created_at')
    .order('citation'))

export const addBenchmark = (row) =>
  one(supabase.from('benchmark_references').insert(row).select('*').single())

export async function updateBenchmark(id, patch) {
  const { error } = await supabase.from('benchmark_references').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteBenchmark(id) {
  const { error } = await supabase.from('benchmark_references').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

/* ---------------------------------------------------------------- accounts */

export const fetchProfiles = () =>
  one(supabase
    .from('research_profiles')
    .select('id,full_name,tier,can_run_models,can_train_models,status,created_by,created_at')
    .order('created_at', { ascending: false }))

/** Provision an account -- login and profile in one step.
 *
 * CREATES THE LOGIN TOO, which this bundle cannot do itself: the Auth Admin API
 * needs the service_role key, and that key bypasses RLS and must never ship to
 * a browser. The ML service already holds it, so the browser sends its own
 * access token to POST /research/accounts and the service does the rest --
 * re-checking the hierarchy in Python (accounts._rules(), a transcription of
 * the research_profiles insert policies, since the service key bypasses them),
 * creating the login, inserting the profile, and deleting the login again if
 * the profile insert fails.
 *
 * The two flags apply to a researcher only; a lead carries both by table
 * constraint and the service forces them.
 */
export async function provisionProfile(me, { email, password, fullName, tier, canRun, canTrain }) {
  const { data: s } = await supabase.auth.getSession()
  const token = s.session?.access_token
  if (!token) throw new Error('Your session has expired. Sign in again.')
  if (!API) {
    throw new Error(
      'VITE_ML_API_URL is not set in this build, so accounts cannot be created '
      + 'from the portal. Set it and rebuild, or add the user in Supabase Studio.'
    )
  }

  const res = await fetch(`${API}/research/accounts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, password, full_name: fullName, tier,
      can_run_models: tier === 'researcher' ? Boolean(canRun) : true,
      can_train_models: tier === 'researcher' ? Boolean(canTrain) : true,
    }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.detail || `Could not create the account (HTTP ${res.status}).`)
  return json
}

export async function updateProfile(id, patch) {
  const { error } = await supabase.from('research_profiles').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

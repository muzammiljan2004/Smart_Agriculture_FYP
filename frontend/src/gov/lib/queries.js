/** Every read and write the government portal makes.
 *
 * All of it goes through the ordinary anon-key client in src/supabase.js, with
 * the caller's own session, so RLS applies to every row returned here. There is
 * no service-role key in this bundle and no server to proxy through: what a
 * district manager can see is decided in Postgres, and this file cannot widen
 * it. A query here that returns nothing for them is the policy working.
 */
import { supabase } from '../../supabase'

/** PostgREST caps an unbounded select at 1000 rows and does NOT say it
 *  truncated. Several of these tables hold ~2400 rows, so every select that can
 *  exceed the cap passes an explicit range. This project has been bitten by the
 *  silent cap before; it is not left to chance here. */
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

/** Districts the caller may see. For a district manager this is ONE row --
 *  gov_districts is scoped by RLS, and that is what makes their dashboard
 *  district-only without the frontend filtering anything. */
export const fetchDistricts = () =>
  one(supabase.from('gov_districts').select('id,name,province,geom').order('name'))

export const fetchCrops = () =>
  one(supabase.from('gov_crops').select('id,name,category,season').order('name'))

export const fetchSeasons = () =>
  one(supabase.from('gov_seasons').select('id,label,start_date,end_date').order('label'))

/** The caller's own profile, with their district's name for the header.
 *
 * Returns null when a signed-in auth user has no gov_profiles row. That is a
 * real state, not an error: the portal is invite-only, so somebody with a
 * Supabase account but no provisioned profile is simply not a government user
 * and has to be told so rather than shown an empty dashboard.
 */
export async function fetchMyProfile() {
  const { data: session } = await supabase.auth.getSession()
  const uid = session.session?.user?.id
  if (!uid) return null
  const { data, error } = await supabase
    .from('gov_profiles')
    .select('id,full_name,tier,designation,status,district_id,created_at,gov_districts(name)')
    .eq('id', uid)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

/* ----------------------------------------------------------- season facts
 *
 * The join most screens are built from: one row per district for a given crop
 * and season, carrying whatever each table has for it.
 *
 * Assembled client-side from four selects rather than as one SQL join, because
 * PostgREST cannot full-outer-join four tables and an inner join would silently
 * DROP districts: barley has no prediction (the model was never trained on it)
 * and no district has an area estimate at all. A district missing from a table
 * has to come back with null for that column, not vanish from the province.
 */
export async function fetchSeasonFacts({ cropId, seasonId, districts }) {
  if (!cropId || !seasonId) return []
  const eq = (t, cols) =>
    all(() => supabase.from(t).select(cols).eq('crop_id', cropId).eq('season_id', seasonId))

  const [preds, actuals, indices, areas, harvest] = await Promise.all([
    eq('gov_yield_predictions', 'district_id,predicted_yield,ci_low,ci_high,model_used,lead_days,evaluation'),
    eq('gov_yield_actuals', 'district_id,yield_t_ha,source,confidence'),
    eq('gov_satellite_indices', 'district_id,date,ndvi,evi,ndwi,savi,nbr,source'),
    eq('gov_crop_area_estimates', 'district_id,estimated_area_ha,prev_season_area_ha,accuracy_pct'),
    eq('gov_harvest_progress', 'district_id,harvested_area_ha,remaining_area_ha,last_updated'),
  ])

  const byId = (rows) => new Map(rows.map((r) => [r.district_id, r]))
  const P = byId(preds), A = byId(actuals), I = byId(indices)
  const R = byId(areas), H = byId(harvest)

  return districts.map((d) => {
    const h = H.get(d.id)
    const total = h ? Number(h.harvested_area_ha) + Number(h.remaining_area_ha) : null
    return {
      district_id: d.id,
      name: d.name,
      prediction: P.get(d.id) || null,
      actual: A.get(d.id) || null,
      indices: I.get(d.id) || null,
      area: R.get(d.id) || null,
      harvest: h || null,
      // Only derived where the inputs exist. No fallback: a null harvest
      // percentage renders as a dash, never as 0%.
      harvest_pct: total ? (Number(h.harvested_area_ha) / total) * 100 : null,
    }
  })
}

/** Every season's value for one district+crop, for a trend line. */
export async function fetchDistrictHistory({ districtId, cropId }) {
  const [actuals, preds, indices] = await Promise.all([
    all(() => supabase.from('gov_yield_actuals')
      .select('season_id,yield_t_ha,source,confidence')
      .eq('district_id', districtId).eq('crop_id', cropId)),
    all(() => supabase.from('gov_yield_predictions')
      .select('season_id,predicted_yield,ci_low,ci_high,evaluation,lead_days')
      .eq('district_id', districtId).eq('crop_id', cropId)),
    all(() => supabase.from('gov_satellite_indices')
      .select('season_id,date,ndvi,evi,ndwi,savi,nbr')
      .eq('district_id', districtId).eq('crop_id', cropId)),
  ])
  return { actuals, preds, indices }
}

/** Province-wide series for one crop across every season, for screen 6. */
export async function fetchCropHistory({ cropId }) {
  const [actuals, preds, indices] = await Promise.all([
    all(() => supabase.from('gov_yield_actuals')
      .select('district_id,season_id,yield_t_ha').eq('crop_id', cropId)),
    all(() => supabase.from('gov_yield_predictions')
      .select('district_id,season_id,predicted_yield,ci_low,ci_high,evaluation,lead_days')
      .eq('crop_id', cropId)),
    all(() => supabase.from('gov_satellite_indices')
      .select('district_id,season_id,ndvi,evi,ndwi,savi,nbr').eq('crop_id', cropId)),
  ])
  return { actuals, preds, indices }
}

/** Area estimates for every crop in a season — screen 5's stacked chart. */
export const fetchAreaEstimates = ({ seasonId }) =>
  all(() => supabase.from('gov_crop_area_estimates')
    .select('district_id,crop_id,estimated_area_ha,prev_season_area_ha,accuracy_pct,method')
    .eq('season_id', seasonId))

export const fetchHarvestProgress = ({ seasonId }) =>
  all(() => supabase.from('gov_harvest_progress')
    .select('district_id,crop_id,harvested_area_ha,remaining_area_ha,last_updated')
    .eq('season_id', seasonId))

/* ------------------------------------------------------------------ alerts */

export const fetchRiskAlerts = ({ seasonId } = {}) =>
  all(() => {
    let q = supabase.from('gov_risk_alerts')
      .select('id,district_id,crop_id,season_id,alert_type,severity,message,details,triggered_at,resolved,' +
              'gov_districts(name),gov_crops(name)')
      .order('triggered_at', { ascending: false })
    if (seasonId) q = q.eq('season_id', seasonId)
    return q
  })

/* ----------------------------------------------------------------- subsidy */

export const fetchSubsidy = ({ seasonId, cropId, resourceType }) =>
  all(() => {
    let q = supabase.from('gov_subsidy_recommendations')
      .select('id,district_id,crop_id,season_id,resource_type,rank,reason,yield_deficit_pct,' +
              'resource_access_score,priority_score,gov_districts(name),gov_crops(name)')
      .order('priority_score', { ascending: false })
    if (seasonId) q = q.eq('season_id', seasonId)
    if (cropId) q = q.eq('crop_id', cropId)
    if (resourceType) q = q.eq('resource_type', resourceType)
    return q
  })

/** Which resource types actually have rows. The design showed four fixed tabs;
 *  only the water rule has been implemented upstream, so the tabs are driven by
 *  the data and the screen never offers an empty one. */
export async function fetchSubsidyResourceTypes() {
  const rows = await all(() =>
    supabase.from('gov_subsidy_recommendations').select('resource_type'))
  return [...new Set(rows.map((r) => r.resource_type))].sort()
}

/* ------------------------------------------------------------------ surveys */

export const fetchSurveys = () =>
  all(() => supabase.from('gov_field_surveys')
    .select('id,officer_id,district_id,crop_id,season_id,survey_type,sowing_date,harvest_date,' +
            'verified_yield,observed_value,notes,status,reviewed_by,reviewed_at,submitted_at,' +
            'gov_districts(name),gov_crops(name),gov_seasons(label)')
    .order('submitted_at', { ascending: false }))

/** officer_id, district_id and status are NOT taken from the caller here --
 *  they are set from the session and the profile, and RLS re-checks all three.
 *  Sending them from a form field would be a hole the policy then closes, which
 *  is a 403 the user cannot act on rather than a bug they never hit. */
export async function submitSurvey(profile, form) {
  const { error } = await supabase.from('gov_field_surveys').insert({
    officer_id: profile.id,
    district_id: profile.district_id,
    crop_id: form.crop_id,
    season_id: form.season_id,
    survey_type: form.survey_type,
    sowing_date: form.sowing_date || null,
    harvest_date: form.harvest_date || null,
    verified_yield: form.verified_yield === '' ? null : Number(form.verified_yield),
    observed_value: form.observed_value || null,
    notes: form.notes || null,
    gps_lat: form.gps_lat === '' ? null : Number(form.gps_lat),
    gps_lng: form.gps_lng === '' ? null : Number(form.gps_lng),
    status: 'pending',
  })
  if (error) throw new Error(error.message)
}

export async function reviewSurvey(id, status, reviewerId) {
  const { error } = await supabase.from('gov_field_surveys')
    .update({ status, reviewed_by: reviewerId, reviewed_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

/* ----------------------------------------------------------------- datasets */

export const fetchDatasets = () =>
  all(() => supabase.from('gov_datasets')
    .select('id,name,description,source,coverage,file_url,version,district_id,status,' +
            'quality_score,record_count,uploaded_by,uploaded_at,gov_districts(name)')
    .order('uploaded_at', { ascending: false }))

export async function setDatasetStatus(id, status) {
  const { error } = await supabase.from('gov_datasets').update({ status }).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function addDataset(profile, form) {
  const { error } = await supabase.from('gov_datasets').insert({
    name: form.name,
    version: form.version || '1',
    description: form.description || null,
    source: form.source || null,
    coverage: form.coverage || null,
    file_url: form.file_url || null,
    // A super admin may register province-wide data (null district); a manager
    // may only register their own district's, and RLS enforces exactly that.
    district_id: profile.tier === 'super_admin' ? null : profile.district_id,
    uploaded_by: profile.id,
    status: 'pending',
  })
  if (error) throw new Error(error.message)
}

/* -------------------------------------------------------------- access mgmt */

/** Accounts the caller may see. RLS decides the scope; this orders them. */
export const fetchProfiles = () =>
  all(() => supabase.from('gov_profiles')
    .select('id,full_name,tier,designation,district_id,created_by,status,created_at,' +
            'gov_districts(name)')
    .order('created_at'))

/**
 * Provision an account.
 *
 * TWO STEPS, and only the second one happens here. Creating an auth user needs
 * the Admin API and the service_role key, which must never be in a browser
 * bundle -- so the portal cannot create the login itself. The flow is:
 *
 *   1. An administrator adds the user in Supabase Studio (or an invite is sent
 *      through the Auth Admin API from a trusted backend).
 *   2. This grants that user their tier, designation and district.
 *
 * `authUserId` is therefore required and is the id from step 1. The alternative
 * -- shipping a service-role key or an unauthenticated edge function that
 * creates users -- would hand anyone holding the bundle the ability to mint
 * accounts, which is a far worse outcome than a two-step invite.
 */
export async function provisionProfile(me, { authUserId, fullName, tier, designation, districtId }) {
  const { error } = await supabase.from('gov_profiles').insert({
    id: authUserId,
    full_name: fullName,
    tier,
    designation: tier === 'employee' ? designation : null,
    district_id: tier === 'super_admin' ? null : districtId,
    created_by: me.id,
    status: 'active',
  })
  if (error) throw new Error(error.message)
}

export async function updateProfile(id, patch) {
  const { error } = await supabase.from('gov_profiles').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

/* --------------------------------------------------------------- model card
 *
 * Read from the dataset registry rather than hardcoded, so the accuracy the
 * portal publishes is whatever the pipeline last wrote. A number typed into the
 * frontend would keep claiming an R-squared the model no longer has.
 */
export async function fetchModelCard() {
  const rows = await all(() => supabase.from('gov_datasets')
    .select('name,description,coverage,version,uploaded_at,record_count')
    .ilike('name', '%yield model%'))
  return rows[0] || null
}

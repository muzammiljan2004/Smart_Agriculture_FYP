/** Who may see and do what, in one place.
 *
 * IMPORTANT, and worth being blunt about: nothing in this file is a security
 * control. Every rule here has a matching RLS policy in
 * supabase/migrations/20261003100100_gov_portal_rls.sql, and the policy is the
 * one that decides. This file exists so the interface does not offer an action
 * that the database will then refuse -- hiding a button is courtesy, not
 * enforcement, and a user who reaches a hidden screen by editing the URL fragment
 * sees empty panels because the rows do not come back, not because of anything
 * below.
 *
 * The two layers are deliberately written to the same shape so they can be read
 * side by side and checked against each other.
 */

export const TIERS = {
  super_admin: 'Super Admin',
  district_manager: 'District Manager',
  employee: 'Employee',
}

export const DESIGNATIONS = {
  agriculture_officer: 'Agriculture Officer',
  district_officer: 'District Officer',
  analyst: 'Analyst',
}

export const roleLabel = (p) =>
  !p ? '—'
    : p.tier === 'employee' ? (DESIGNATIONS[p.designation] || 'Employee')
      : TIERS[p.tier]

/* ------------------------------------------------------------- capabilities
 *
 * Mirrors the RLS policies named in each comment. If one of these changes, the
 * policy has to change with it or the UI starts promising something Postgres
 * refuses.
 */

/** RLS: "gov officers submit surveys" — designation gate, not tier. An analyst
 *  is an employee too, and an analyst does not do field work. */
export const canSubmitSurvey = (p) =>
  p?.status === 'active' &&
  p.tier === 'employee' &&
  ['agriculture_officer', 'district_officer'].includes(p.designation)

/** RLS: "gov managers adjudicate surveys". */
export const canReviewSurvey = (p) =>
  p?.status === 'active' && ['district_manager', 'super_admin'].includes(p.tier)

/** RLS: "gov admins upload datasets" / "gov admins update datasets". */
export const canManageDatasets = (p) =>
  p?.status === 'active' && ['district_manager', 'super_admin'].includes(p.tier)

/** RLS: the four gov_profiles write policies. A super admin provisions district
 *  managers; a district manager provisions employees; an employee provisions
 *  nobody and sees screen 14 read-only. */
export const canManageAccounts = (p) =>
  p?.status === 'active' && ['district_manager', 'super_admin'].includes(p.tier)

/** What tier the caller is allowed to create. Returns null for an employee. */
export const provisionableTier = (p) =>
  p?.tier === 'super_admin' ? 'district_manager'
    : p?.tier === 'district_manager' ? 'employee'
      : null

/** True where the caller sees the whole province rather than one district. */
export const isProvincial = (p) => p?.tier === 'super_admin'

/* ----------------------------------------------------------------- screens
 *
 * Order and grouping are the design's sidebar, which differs slightly from the
 * brief's: the design groups 15 screens under five headings and the brief lists
 * 14 under five differently-named ones. The design is the stated source of truth
 * for layout and flow, so its structure is kept; the brief's extra requirements
 * for screen 14 are folded into it, and the title is the brief's
 * ("User & Access Management") because that screen's behaviour is specified
 * there in far more detail.
 *
 * `allow` is omitted where every active profile may open the screen, which is
 * most of them -- the portal is analytical and the scoping happens in the rows,
 * not the routes.
 */
export const SCREENS = [
  { id: 'dashboard', title: 'Punjab agriculture overview',
    sub: 'Province-level monitoring across the districts you have access to',
    nav: 'Dashboard', icon: 'dash' },

  { id: 'district', title: 'District monitoring',
    sub: 'Compare crop condition and yield district by district',
    nav: 'District Monitoring', group: 'Monitoring', icon: 'sat' },
  { id: 'crop', title: 'Crop monitoring',
    sub: 'Canopy health and reported yield for each crop',
    nav: 'Crop Monitoring', group: 'Monitoring', icon: 'sat' },
  { id: 'satellite', title: 'Satellite monitoring',
    sub: 'Vegetation and water indices from Sentinel-2 composites',
    nav: 'Satellite Monitoring', group: 'Monitoring', icon: 'sat' },
  { id: 'harvest', title: 'Harvest monitoring',
    sub: 'Harvested and remaining area, by district and crop',
    nav: 'Harvest Monitoring', group: 'Monitoring', icon: 'sat' },

  { id: 'area', title: 'Crop area estimation',
    sub: 'Satellite-derived cultivated area by crop and district',
    nav: 'Crop Area Estimation', group: 'Estimation & Forecast', icon: 'chart' },
  { id: 'stats', title: 'Production & yield statistics',
    sub: 'Reported production, area and yield across seasons',
    nav: 'Production & Yield Statistics', group: 'Estimation & Forecast', icon: 'chart' },
  { id: 'forecast', title: 'Yield forecasting',
    sub: 'District yield estimates ahead of harvest, and how far ahead',
    nav: 'Yield Forecasting', group: 'Estimation & Forecast', icon: 'chart' },

  { id: 'subsidy', title: 'Subsidy & resources',
    sub: 'Target support where a yield deficit meets poor water access',
    nav: 'Subsidy & Resources', group: 'Planning & Risk', icon: 'alert' },
  { id: 'risk', title: 'Risk & alerts',
    sub: 'Authority-side drought, water-stress, flood and anomaly detection',
    nav: 'Risk & Alerts', group: 'Planning & Risk', icon: 'alert' },

  { id: 'survey', title: 'Field survey',
    sub: 'Officer observations of crop, sowing, harvest and yield',
    nav: 'Field Survey', group: 'Field & Data', icon: 'db' },
  { id: 'data', title: 'Data management',
    sub: 'Registered datasets, provenance and verification state',
    nav: 'Data Management', group: 'Field & Data', icon: 'db' },

  { id: 'reports', title: 'Reports & analytics',
    sub: 'Build a view and export it',
    nav: 'Reports & Analytics', icon: 'file' },
  { id: 'roles', title: 'User & access management',
    sub: 'Accounts you provision, and the scope they carry',
    nav: 'User & Access Management', icon: 'users' },
  { id: 'settings', title: 'Settings',
    sub: 'Your account and display preferences',
    nav: 'Settings', icon: 'gear' },
]

export const screenById = (id) => SCREENS.find((s) => s.id === id)

export const visibleScreens = (p) => SCREENS.filter((s) => !s.allow || s.allow(p))

/** The sidebar, as [{ nav, icon, items? }] in the design's order. */
export function navTree(profile) {
  const out = []
  for (const s of visibleScreens(profile)) {
    if (!s.group) { out.push({ single: s }); continue }
    const existing = out.find((n) => n.group === s.group)
    if (existing) existing.items.push(s)
    else out.push({ group: s.group, icon: s.icon, items: [s] })
  }
  return out
}

export const groupOf = (id) => screenById(id)?.group ?? null

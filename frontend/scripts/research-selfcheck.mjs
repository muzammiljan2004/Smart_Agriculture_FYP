/**
 * Researcher portal selfcheck.
 *
 * Run: node scripts/research-selfcheck.mjs
 *
 * WHAT THIS IS FOR. The portal has two layers that must agree: the capability
 * predicates in src/research/lib/access.js, which decide what the interface
 * offers, and the RLS policies in the migration, which decide what Postgres
 * allows. When they disagree the UI either promises an action the database
 * refuses, or hides one it would have permitted -- and neither shows up in a
 * build. So the pairs are checked here against a table of account shapes.
 *
 * This is NOT a substitute for live RLS verification. It cannot be: it runs
 * offline with no database. It verifies the mirror is faithful and that the
 * SQL says what the mirror claims it says. Proving Postgres actually refuses a
 * crafted request needs real accounts against the real project, which is what
 * ml-service/scripts/verify_research_rls.py does once the policies are applied.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(root, '..')
const fails = []
const ok = (m) => console.log('  ok   ' + m)
const check = (cond, m) => (cond ? ok(m) : (fails.push(m), console.log('  FAIL ' + m)))

const access = await import(pathToFileURL(resolve(root, 'src/research/lib/access.js')).href)
const {
  SCREENS, MODEL_TYPES, STATUSES, TRAINABLE, UNTRAINABLE_REASON,
  canRun, canTrain, canPromote, canManageAccounts, canEditBenchmarks,
  canOpenOperations, isSuperAdmin, provisionableTiers, visibleScreens, navTree,
} = access

const rls = readFileSync(
  resolve(repo, 'supabase/migrations/20261004100100_research_portal_rls.sql'), 'utf8')

// Comment-stripped copy, for checks that must not match prose. The file
// explains in a comment that no policy reaches public.farms; searching the raw
// text for that table name would match the explanation and fail on correct SQL.
const rlsCode = rls.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
const schema = readFileSync(
  resolve(repo, 'supabase/migrations/20261004100000_research_portal_schema.sql'), 'utf8')
const pyResearch = readFileSync(resolve(repo, 'ml-service/app/research.py'), 'utf8')
const pagesIndex = readFileSync(resolve(root, 'src/research/pages/index.js'), 'utf8')

/* ----------------------------------------------------------- account shapes */

const P = (over = {}) => ({
  id: 'u1', full_name: 'T', status: 'active',
  tier: 'researcher', can_run_models: false, can_train_models: false, ...over,
})

const nobody = P()
const runner = P({ can_run_models: true })
const trainer = P({ can_train_models: true })
const both = P({ can_run_models: true, can_train_models: true })
const lead = P({ tier: 'research_lead', can_run_models: true, can_train_models: true })
const admin = P({ tier: 'super_admin', can_run_models: true, can_train_models: true })
const offRunner = P({ can_run_models: true, status: 'deactivated' })
const offLead = P({ tier: 'research_lead', can_run_models: true, can_train_models: true, status: 'deactivated' })

console.log('\ncapability predicates mirror the RLS helpers')

// research_can_run(): can_run_models OR super admin, and active either way.
check(!canRun(nobody), 'a flagless researcher cannot run')
check(canRun(runner), 'can_run_models grants run')
check(!canRun(trainer), 'can_train_models alone does NOT grant run')
check(canRun(lead) && canRun(admin), 'a lead and an admin can run')
check(!canRun(offRunner), 'a deactivated account with the flag cannot run')
check(!canRun(null) && !canRun(undefined), 'no profile cannot run')

// research_can_train(): the mirror of the above.
check(!canTrain(nobody), 'a flagless researcher cannot train')
check(canTrain(trainer), 'can_train_models grants train')
check(!canTrain(runner), 'can_run_models alone does NOT grant train')
check(canTrain(lead) && canTrain(admin), 'a lead and an admin can train')
check(!canTrain(offLead), 'a deactivated lead cannot train')

// research_can_promote(): TIER, never a flag. This is the one the brief is
// most emphatic about, so it gets the most cases.
check(!canPromote(both),
  'a researcher with BOTH flags still cannot promote — promotion is a tier, not a flag')
check(!canPromote(runner) && !canPromote(trainer) && !canPromote(nobody),
  'no researcher can promote, whatever their flags')
check(canPromote(lead), 'a research lead can promote')
check(canPromote(admin), 'a super admin can promote')
check(!canPromote(offLead), 'a deactivated lead cannot promote')

check(canManageAccounts(lead) && canManageAccounts(admin) && !canManageAccounts(both),
  'account management tracks the promote tier')
check(canEditBenchmarks(lead) && !canEditBenchmarks(both),
  'benchmark editing tracks the promote tier')
check(isSuperAdmin(admin) && !isSuperAdmin(lead), 'super admin is distinguished from lead')

console.log('\nno tier can provision its own tier or higher')
check(JSON.stringify(provisionableTiers(admin)) === JSON.stringify(['research_lead', 'researcher']),
  'a super admin provisions leads and researchers, NOT another super admin')
check(JSON.stringify(provisionableTiers(lead)) === JSON.stringify(['researcher']),
  'a lead provisions researchers only, NOT another lead')
check(provisionableTiers(both).length === 0, 'a researcher provisions nobody')
check(provisionableTiers(offLead).length === 0, 'a deactivated lead provisions nobody')
for (const [who, p] of [['super admin', admin], ['lead', lead], ['researcher', both]]) {
  const granted = provisionableTiers(p)
  check(!granted.includes(p.tier), `${who} cannot grant its own tier (${p.tier})`)
  check(!granted.includes('super_admin') || p.tier === 'nothing',
    `${who} cannot grant super_admin`)
}

console.log('\nnavigation hides what an account cannot use')
const ids = (p) => visibleScreens(p).map((s) => s.id)
check(!ids(nobody).includes('operations'),
  'a flagless researcher gets no Train & Run screen at all')
check(ids(runner).includes('operations'), 'can_run_models reveals Train & Run')
check(ids(trainer).includes('operations'), 'can_train_models reveals Train & Run')
check(ids(lead).includes('operations'), 'a lead sees Train & Run')
check(ids(nobody).includes('comparison') && ids(nobody).includes('history'),
  'a flagless researcher still sees the analytical screens')
check(ids(nobody).includes('access'),
  'everyone sees the access screen — a researcher reads their own flags there')
check(visibleScreens(P({ status: 'deactivated' })).length === 0,
  'a deactivated account sees no screens')
check(canOpenOperations(both) && !canOpenOperations(nobody),
  'canOpenOperations agrees with the three action gates')

console.log('\nscreens and pages agree')
check(SCREENS.length === 11, `11 screens defined (found ${SCREENS.length})`)
for (const s of SCREENS) {
  check(new RegExp(`\\b${s.id}:\\s*\\w+Page`).test(pagesIndex),
    `screen "${s.id}" has a page component in pages/index.js`)
}
const mapped = [...pagesIndex.matchAll(/^\s{2}(\w+):\s*\w+Page,/gm)].map((m) => m[1])
for (const key of mapped) {
  check(SCREENS.some((s) => s.id === key), `page key "${key}" is a declared screen`)
}
check(new Set(SCREENS.map((s) => s.id)).size === SCREENS.length, 'screen ids are unique')
check(SCREENS.every((s) => s.nav && s.title), 'every screen has a nav label and a title')
// The sidebar tree must not drop or duplicate a screen.
const flat = navTree(lead).flatMap((n) => (n.single ? [n.single.id] : n.items.map((s) => s.id)))
check(flat.length === ids(lead).length && new Set(flat).size === flat.length,
  'navTree contains every visible screen exactly once')

console.log('\nthe SQL says what access.js claims it says')
for (const fn of ['research_tier', 'research_is_super_admin', 'research_active',
                  'research_can_run', 'research_can_train', 'research_can_promote']) {
  check(rls.includes(`function public.${fn}(`), `helper ${fn}() is defined`)
  check(new RegExp(`grant execute on function public\\.${fn}\\(\\)\\s+to authenticated`)
    .test(rls), `${fn}() is granted to authenticated`)
}

// THE ORDERING BUG THIS PROJECT ALREADY HIT ONCE. Revoking the implicit PUBLIC
// grant without an explicit re-grant locks every user out of every table,
// because the policies CALL these functions.
const firstGrant = rls.indexOf('grant execute on function public.research_tier')
const firstRevoke = rls.indexOf('revoke execute on function public.research_tier')
check(firstGrant > -1 && firstRevoke > -1 && firstGrant < firstRevoke,
  'grant execute comes BEFORE revoke from public — or every user is locked out')

check(/revoke update on public\.model_runs from authenticated/.test(rls)
   && /grant\s+update \(status\) on public\.model_runs to authenticated/.test(rls),
  'UPDATE on model_runs is narrowed to the status column alone')

// Action C must be the only thing that writes a status, and only on a version.
check(/create policy "research leads promote models" on public\.model_runs[\s\S]{0,400}?for update/
  .test(rls), 'the only model_runs update policy is the promotion one')
check((rls.match(/on public\.model_runs\s+for update/g) || []).length === 1,
  'exactly one UPDATE policy exists on model_runs')

// Action B can only ever create a candidate.
const trainPolicy = rls.slice(rls.indexOf('"research trains models"'),
                              rls.indexOf('"research leads promote models"'))
check(/status = 'candidate'/.test(trainPolicy),
  "the training insert policy pins status = 'candidate'")
check(/job_status = 'queued'/.test(trainPolicy),
  'the training insert policy pins job_status = queued')
check(/r2 is null/.test(trainPolicy) && /f1_score is null/.test(trainPolicy),
  'the training insert policy pins every metric to null — no fabricated results')

const evalPolicy = rls.slice(rls.indexOf('"research runs evaluations"'),
                             rls.indexOf('"research trains models"'))
check(/status is null/.test(evalPolicy),
  'the evaluation insert policy forbids a status, so a run can never be promoted')
check(/r2 is null/.test(evalPolicy),
  'the evaluation insert policy pins every metric to null')

// No self-update, at any tier -- the mechanism behind "no account can change
// its own flags or tier".
const updates = [...rls.matchAll(/create policy "([^"]+)" on public\.research_profiles\s+for update[\s\S]*?;/g)]
check(updates.length === 2, `two update policies on research_profiles (found ${updates.length})`)
for (const [body, name] of updates.map((m) => [m[0], m[1]])) {
  check((body.match(/id <> \(select auth\.uid\(\)\)/g) || []).length >= 2,
    `"${name}" excludes the caller's own row in both USING and WITH CHECK`)
}
check(!/on public\.research_profiles\s+for delete/.test(rls),
  'there is no delete policy on research_profiles — accounts are deactivated')
check(!/on public\.model_runs\s+for delete/.test(rls),
  'there is no delete policy on model_runs — promoting never deletes a version')

// Upstream tables stay read-only from this portal.
for (const t of ['gov_yield_predictions', 'gov_satellite_indices', 'gov_yield_actuals',
                 'gov_field_surveys', 'gov_districts', 'gov_crops', 'gov_seasons']) {
  check(new RegExp(`on public\\.${t}\\s+for select`).test(rls),
    `${t} has a research SELECT policy`)
  const writes = new RegExp(`create policy "research[^"]*" on public\\.${t}\\s+for (insert|update|delete)`)
  check(!writes.test(rls), `${t} has NO research write policy — read-only from this portal`)
}
check(!/public\.farms/.test(rlsCode),
  'no policy in this migration touches public.farms — individual farm rows stay invisible')
check(/status = 'verified'/.test(rls),
  'field surveys are restricted to verified rows')

console.log('\nschema invariants the UI relies on')
check(/constraint research_profiles_lead_flags check \(/.test(schema),
  'a lead is constrained to carry both flags, which access.js assumes')
check(/constraint model_runs_status_scope check \(/.test(schema),
  'an evaluation is constrained to have no status')
check(/create unique index if not exists model_runs_one_production_per_type/.test(schema),
  'at most one production version per model type')
for (const t of MODEL_TYPES) {
  check(schema.includes(`'${t}'`), `model type ${t} is allowed by the schema check`)
}
for (const s of STATUSES) {
  check(new RegExp(`status text check \\(status in \\([^)]*'${s}'`).test(schema.replace(/\s+/g, ' '))
     || schema.includes(`'${s}'`), `status ${s} is allowed by the schema check`)
}

console.log('\nthe trainable-model list matches the ML service')
const pyTrainable = [...(pyResearch.match(/TRAINABLE = \{([^}]*)\}/)?.[1] ?? '')
  .matchAll(/"([^"]+)"/g)].map((m) => m[1])
check(pyTrainable.length > 0, `research.py declares TRAINABLE (${pyTrainable.join(', ')})`)
check(JSON.stringify([...pyTrainable].sort()) === JSON.stringify([...TRAINABLE].sort()),
  `access.js TRAINABLE [${TRAINABLE}] matches research.py [${pyTrainable}]`)
for (const t of MODEL_TYPES) {
  if (!TRAINABLE.includes(t)) {
    check(Boolean(UNTRAINABLE_REASON[t]),
      `${t} is offered but not trainable, and carries a stated reason`)
  }
}

console.log('\na gated submit control cannot look ready while it is disabled')
const rui = readFileSync(resolve(root, 'src/research/lib/rui.jsx'), 'utf8')
// With all={null} and no option matching value="", a browser shows the FIRST
// option while the state is still null -- the control reads as chosen and the
// button it gates stays disabled, so clicking Run appears to do nothing.
check(/all != null$/m.test(rui) && /placeholder/.test(rui),
  'Select renders a placeholder option when all={null} and nothing is chosen')
const ops = readFileSync(resolve(root, 'src/research/pages/OperationsPage.jsx'), 'utf8')
check(/disabled=\{busy \|\| !picked\.length \|\| !datasetId\}/.test(ops)
   && /Pick a dataset version to evaluate against/.test(ops),
  'the disabled Run button states which choice is missing')
check(/if \(e\.runId\) onQueued\(e\.runId\)/.test(ops),
  'a failed hand-off still points the page at the queued run')

console.log('\nrun-scope filters do not inherit the shell\'s observation defaults')
// The shell defaults crop to wheat and season to the newest one, which is right
// for screens reading observations and wrong for screens reading model_runs:
// crop_id/district_id/season_id are an OPTIONAL scope there, null on any run
// covering everything. Inheriting the default hid every run behind a filter the
// user never set, on a screen whose subtitle promised nothing was filtered.
const cmp = readFileSync(resolve(root, 'src/research/pages/ComparisonPage.jsx'), 'utf8')
const cmpArgs = cmp.match(/function ComparisonPage\(\{([^}]*)\}/)?.[1] ?? ''
for (const p of ['crop', 'season', 'district']) {
  check(!new RegExp(`\\b${p}\\b`).test(cmpArgs),
    `ComparisonPage does not take ${p} from the shell's shared filter state`)
  check(new RegExp(`useState\\(null\\)[\\s\\S]{0,400}?set${p[0].toUpperCase()}${p.slice(1)}`)
        .test(cmp) || new RegExp(`\\[${p}, set`).test(cmp),
    `ComparisonPage holds its own ${p} filter, starting unset`)
}

console.log('\nevery column the portal selects exists in the migrated schema')
/* A wrong column name is not a type error and not a build error -- it is a
 * runtime PostgREST 400 that reaches the user as "Could not load this section",
 * on one screen, only once someone opens it. `gov_yield_actuals.actual_yield`
 * shipped that way: the upload CSV's target column is called actual_yield and
 * the table's is yield_t_ha, and nothing in the toolchain compared the two.
 * So compare them here, against the CREATE TABLE text in the migrations. */
const sqlAll = [
  'supabase/migrations/20261003100000_gov_portal_schema.sql',
  'supabase/migrations/20261004100000_research_portal_schema.sql',
].map((f) => readFileSync(resolve(repo, f), 'utf8')).join('\n')

/** table -> declared column names, read from `create table ... ( ... );` */
const declared = new Map()
for (const m of sqlAll.matchAll(
  /create table if not exists (?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const cols = new Set()
  for (const line of m[2].split('\n')) {
    const t = line.replace(/--.*$/, '').trim()
    // Skip table-level constraints; a column line starts with its own name.
    if (!t || /^(constraint|primary key|unique|check|foreign key|exclude)\b/i.test(t)) continue
    const name = t.match(/^(\w+)\s/)?.[1]
    if (name) cols.add(name)
  }
  declared.set(m[1], cols)
}
check(declared.size > 0, `parsed ${declared.size} create-table blocks from the migrations`)

const queries = readFileSync(resolve(root, 'src/research/lib/queries.js'), 'utf8')
let pairs = 0
for (const m of queries.matchAll(
  /\.from\('(\w+)'\)\s*\n?\s*\.select\(((?:\s*'[^']*'\s*\+?)+)\)/g)) {
  const tbl = m[1]
  const cols = declared.get(tbl)
  if (!cols) continue                        // view, or a table owned elsewhere
  const listed = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]).join('')
    .replace(/\([^)]*\)/g, '')               // drop embedded relation selects
    .split(',').map((c) => c.trim())
    // Drop joined relations, including the `table!fk_name(...)` form PostgREST
    // needs where two foreign keys point at the same table.
    .filter((c) => c && c !== '*' && !declared.has(c.split('!')[0]))
  for (const c of listed) {
    pairs += 1
    check(cols.has(c), `${tbl}.${c} exists`)
  }
}
check(pairs > 50, `${pairs} table/column pairs checked against the schema`)

console.log(fails.length ? `\n${fails.length} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(fails.length ? 1 : 0)

/* Database errors reach the user as a sentence, not as schema.
 *
 * Run: node scripts/dberror-selfcheck.mjs
 *
 * THIS IS NOT AN INJECTION TEST, because there is nothing to test. Every read
 * and write in this project goes through PostgREST, which parameterises values
 * and generates the SQL itself; the application code contains no raw SQL, no
 * .rpc(), and no user value interpolated into a filter string. The checks below
 * assert that second claim mechanically, so it cannot quietly stop being true.
 *
 * What the checks mostly cover is the consequence of the input bounds added in
 * 20261006120000_input_length_bounds.sql: when one of them fires, PostgREST
 * returns the raw Postgres message, which names tables, constraints and
 * policies. Every screen was printing those verbatim.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dbError } from '../src/lib/dbError.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Source with comments removed.
 *
 * Every check below is about what the CODE does. Without this, the scan matches
 * the prose that explains it -- dbError.js's own header contains the string
 * "' OR 1=1 --" and the phrase "no .rpc()", and both were reported as findings
 * against the file documenting why they are absent.
 */
const code = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')
const fails = []
const check = (cond, m) => (cond ? console.log('  ok   ' + m)
  : (fails.push(m), console.log('  FAIL ' + m)))

console.log('a rejected value is explained, not dumped')
const cases = [
  [{ code: '23514', message: 'new row for relation "farms" violates check constraint "farms_farmer_name_len"' },
   'between 1 and 120'],
  [{ code: '23514', message: 'violates check constraint "farms_gps_lat_check"' }, 'between -90 and 90'],
  [{ code: '23514', message: 'violates check constraint "farms_crop_season_match"' }, 'does not grow'],
  [{ code: '23505', message: 'duplicate key value violates unique constraint "model_runs_one_production_per_type"' },
   'Archive it first'],
  [{ code: '23503', message: 'insert or update on table "x" violates foreign key constraint "y"' },
   'no longer exists'],
  [{ code: '22P02', message: 'invalid input syntax for type uuid: "abc"' }, 'format this field expects'],
  [{ code: '42501', message: 'new row violates row-level security policy for table "model_runs"' },
   'do not have permission'],
  [{ code: 'PGRST301', message: 'JWT expired' }, 'session has expired'],
]
for (const [err, want] of cases) {
  const got = dbError(err)
  check(got.includes(want), `${err.code} -> "${got}"`)
}

console.log('\nand the message never leaks schema')
const LEAKS = [/relation "/i, /constraint "/i, /row-level security/i, /\bpolicy\b/i,
  /\bpg_/i, /\bSELECT\b/, /\bINSERT\b/]
for (const [err] of cases) {
  const got = dbError(err)
  for (const leak of LEAKS) {
    check(!leak.test(got), `no ${leak} in the message for ${err.code}`)
  }
}

console.log('\nan unmapped constraint still gets a usable sentence')
const unmapped = dbError({ code: '23514', message: 'violates check constraint "some_future_rule"' })
check(!unmapped.includes('some_future_rule'), 'an unknown constraint name is not shown')
check(unmapped.length > 20, 'and it still says something actionable')

console.log('\nRLS and privilege refusals are indistinguishable')
// Saying "a policy blocked this" tells a prober the row exists and that they
// are close. The same sentence for both reveals nothing about which.
check(dbError({ code: '42501', message: 'row-level security policy' })
      === dbError({ code: 'PGRST116', message: 'permission denied' }),
  'both return the identical message')

console.log('\ninjection strings are values, never syntax')
// Not a sanitiser test -- these must pass THROUGH untouched. A filter that
// rejected quotes would reject "Dera Ghazi Khan" and "O'Brien" too, and would
// protect nothing that parameterisation does not already handle.
const src = code(readFileSync(resolve(root, 'src/lib/dbError.js'), 'utf8'))
for (const payload of ["' OR 1=1 --", "'; DROP TABLE farms; --", "1' UNION SELECT * FROM auth.users --"]) {
  check(!src.includes(payload), `no blocklist entry for ${JSON.stringify(payload.slice(0, 18))}…`)
}
check(!/\bsanitiz|\bescapeSql|stripQuotes|blacklist|blocklist/i.test(src),
  'no hand-rolled SQL sanitiser exists to be trusted by mistake')

console.log('\nno code path builds SQL from a string')
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f)
  return statSync(p).isDirectory() ? walk(p) : [p]
})
const sources = walk(resolve(root, 'src')).filter((f) => /\.(js|jsx)$/.test(f))
check(sources.length > 40, `${sources.length} source files scanned`)
for (const f of sources) {
  const text = code(readFileSync(f, 'utf8'))
  const rel = f.slice(root.length + 1)
  // .rpc() reaches a Postgres function, which CAN build dynamic SQL inside.
  check(!/\.rpc\s*\(/.test(text), `${rel} calls no .rpc()`)
  // PostgREST's .or() and .filter() take a RAW filter string. A template
  // literal there is the one place in this stack where user input could change
  // the shape of a query rather than only its values.
  check(!/\.(or|filter)\s*\(\s*`/.test(text), `${rel} interpolates nothing into a raw filter`)
  // .ilike/.like patterns must be literals, not user-built templates.
  check(!/\.(i?like)\s*\([^,]+,\s*`/.test(text), `${rel} builds no like-pattern from a template`)
}

console.log(fails.length ? `\n${fails.length} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(fails.length ? 1 : 0)

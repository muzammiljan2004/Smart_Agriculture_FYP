/**
 * Landing-page selfcheck: every portal CTA points at a page that exists.
 *
 * The landing page is static markup, so there is no logic to unit-test -- but
 * there is one thing that rots silently and is embarrassing in front of an
 * evaluator: a CTA linking to an entry point that was renamed, removed or never
 * registered in vite.config.js. The browser reports that as a 404 on the first
 * click, and nothing before this check would have caught it.
 *
 * Run: node scripts/landing-selfcheck.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fails = []
const ok = (m) => console.log('  ok   ' + m)
const check = (cond, m) => (cond ? ok(m) : (fails.push(m), console.log('  FAIL ' + m)))

// Comments are stripped FIRST. index.html still names /researcher.html inside a
// comment -- the path this card used to reserve before the portal shipped at
// /research.html -- and counting a commented path as a live link would make
// this check fail on correct markup.
const raw = readFileSync(resolve(root, 'index.html'), 'utf8')
const html = raw.replace(/<!--[\s\S]*?-->/g, '')
const config = readFileSync(resolve(root, 'vite.config.js'), 'utf8')

console.log('\nlanding page links')

const local = [...new Set([...html.matchAll(/href="(\/[^"#]*\.html)"/g)].map((m) => m[1]))]
check(local.length > 0, 'the page links to at least one portal')

for (const href of local) {
  const file = href.replace(/^\//, '')
  check(existsSync(resolve(root, file)), `${href} exists as a source entry`)
  // An entry absent from rollupOptions.input is NOT built -- Vite silently
  // ships only what is listed, so the file existing on disk is not enough.
  check(config.includes(`'${file}'`), `${href} is registered in vite.config.js`)
}

// The nav and footer jump to sections by id. A renamed section leaves a link
// that scrolls nowhere and reports nothing -- silent, and only noticed by
// whoever clicks it.
console.log('\nin-page anchors')
const anchors = [...new Set([...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]))]
check(anchors.length > 0, 'the page has in-page navigation')
for (const id of anchors) {
  check(html.includes(`id="${id}"`), `#${id} resolves to a real element`)
}
// Every band is reachable from the nav, or it is a section nobody can find.
const sections = [...html.matchAll(/<section class="band[^"]*" id="([^"]+)"/g)].map((m) => m[1])
for (const id of sections) {
  check(anchors.includes(id), `section #${id} is linked from the nav`)
}

// All three portals exist now, so nothing is held back. This block used to
// assert the researcher CTA WAS aria-disabled; that expectation inverted when
// the portal shipped, and the check inverted with it rather than being deleted.
// A live link to a page that is not a registered Vite entry is still the
// failure worth catching, and the loop above does that for every local href.
console.log('\nall portals are live')
check(local.includes('/research.html'),
  'the researcher portal is linked now that it is built')
check(!/aria-disabled="true"/.test(html),
  'no CTA is left disabled')
check(!local.includes('/researcher.html'),
  'the researcher link is /research.html, matching the vite entry name')

console.log('\nstatic by construction')
// The page used to assert zero script tags. It now carries exactly one, inline,
// whose only job is to share the theme choice with the three portals -- CSS can
// swap the tokens but cannot write localStorage. The assertion is tightened
// rather than deleted: no framework, no analytics, nothing fetched over the
// network, which is what "static by construction" was protecting.
const scripts = html.match(/<script\b[^>]*>/g) ?? []
check(scripts.length <= 1, `the landing page ships at most one script tag (${scripts.length})`)
check(scripts.every((s) => !/\bsrc=/.test(s)),
  'no script is loaded from a URL — nothing is fetched to render this page')
// It must write the SAME key src/lib/theme.js reads, or the landing page and
// the portals would each remember a theme the other never sees.
check(!scripts.length || (/'sa\.theme'/.test(html) && /localStorage\.setItem\(KEY/.test(html)),
  'the one script stores the theme under the key the portals read (sa.theme)')
check(!scripts.length || !/\b(fetch|XMLHttpRequest|import\s*\(|eval)\b/.test(html),
  'the one script talks to nothing and loads nothing')
check(/rel="stylesheet"/.test(html), 'the landing stylesheet is linked')

console.log('\naccessibility basics')
check(/<main>/.test(html) && /<header/.test(html) && /<footer>/.test(html),
  'semantic landmarks are present')
check((html.match(/<h1>/g) || []).length === 1, 'exactly one h1')
for (const id of [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1])) {
  check(html.includes(`id="${id}"`), `aria-labelledby="${id}" resolves to a real element`)
}
check(/class="skip"/.test(html), 'a skip link is present')

// THE HONESTY CHECK, and the reason this script is worth more than the link
// checks above. The model section prints holdout figures transcribed from
// docs/step11_temporal_experiment.md. If that document is ever re-run and the
// numbers move, this page keeps quoting the old ones -- a stale accuracy claim
// on the most public surface of the project, which is the single worst thing
// this page could get wrong. So every 4-decimal figure on the page must still
// appear in the document it came from.
console.log('\nmodel figures match docs/')
const docPath = resolve(root, '..', 'docs', 'step11_temporal_experiment.md')
if (existsSync(docPath)) {
  const doc = readFileSync(docPath, 'utf8')
  const figures = [...new Set([...html.matchAll(/(?:>|&minus;)(\d\.\d{4})</g)].map((m) => m[1]))]
  // The Evaluation section was removed from the landing page, so there may be
  // no quoted figures at all now. Any that come back must still match the doc.
  console.log(`  --   ${figures.length} quoted figure(s) to verify`)
  for (const f of figures) {
    check(doc.includes(f), `${f} appears in step11_temporal_experiment.md`)
  }
  check(!/9[0-9]%\s*accur/i.test(html),
    'no percentage accuracy claim (docs explicitly warn against one)')
} else {
  console.log('  --   skipped, docs/step11_temporal_experiment.md not found')
}

// The headline stat band counts real rows. An expanded dataset makes it stale.
const csv = resolve(root, '..', 'ml-service', 'data', 'training_data_real.csv')
if (existsSync(csv)) {
  const rows = readFileSync(csv, 'utf8').trimEnd().split('\n').length - 1 // minus header
  const claimed = Number((html.match(/<b>([\d,]+)<\/b><span>District × crop/) || [])[1]?.replace(/,/g, ''))
  check(claimed === rows, `stat band claims ${claimed} records, dataset has ${rows}`)
}

// If a build is present, confirm the links resolve there too -- that is the
// artefact actually served, and the only place a missing entry shows up.
const dist = resolve(root, 'dist')
if (existsSync(resolve(dist, 'index.html'))) {
  console.log('\nbuilt output (dist/)')
  for (const href of local) {
    check(existsSync(resolve(dist, href.replace(/^\//, ''))), `dist${href} was built`)
  }
} else {
  console.log('\nbuilt output (dist/)\n  --   skipped, no dist yet (run npm run build)')
}

console.log(fails.length ? `\n${fails.length} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(fails.length ? 1 : 0)

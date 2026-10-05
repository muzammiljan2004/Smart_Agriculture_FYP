/**
 * Offline checks for the government portal's pure logic.
 *
 *     node scripts/gov-selfcheck.mjs
 *
 * Covers the three places where a quiet wrong answer is possible and a browser
 * would not show it: the district tessellation (a click resolving to the wrong
 * district), CSV quoting (a shifted column in an exported targeting list), and
 * the formatters that decide whether a missing value prints as a dash or a zero.
 *
 * No framework. Everything imported here is plain JS with no DOM or React
 * dependency, which is why these three modules were kept free of both.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { inPunjab, metresBetween, nearestDistrict, round5 } from '../src/lib/fieldloc.js'
import { districtCells, missingGeometry, PUNJAB_BOUNDS } from '../src/gov/lib/geo.js'
import { clamp, dash, f1, mean, norm, ramp, yieldDec } from '../src/gov/lib/fmt.js'
import { toCsv } from '../src/gov/lib/csv.js'

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message) }
}

// The 34 districts the migration seeds, which must all resolve to a cell.
const SEEDED = [
  'Attock', 'Bahawalnagar', 'Bahawalpur', 'Bhakkar', 'Chakwal', 'Dera Ghazi Khan',
  'Faisalabad', 'Gujranwala', 'Gujrat', 'Hafizabad', 'Jhang', 'Jhelum', 'Kasur',
  'Khanewal', 'Khushab', 'Lahore', 'Layyah', 'Lodhran', 'Mandi Bahauddin', 'Mianwali',
  'Multan', 'Muzaffargarh', 'Narowal', 'Okara', 'Pakpattan', 'Rahim Yar Khan',
  'Rajanpur', 'Rawalpindi', 'Sahiwal', 'Sargodha', 'Sheikhupura', 'Sialkot',
  'Toba Tek Singh', 'Vehari',
]
const rows = SEEDED.map((name, i) => ({ id: 'id' + i, name }))

console.log('geography')

check('every seeded district gets a cell', () => {
  assert.equal(districtCells(rows).length, 34)
  assert.deepEqual(missingGeometry(rows), [])
})

check('a district with no geometry is dropped, not guessed', () => {
  const out = districtCells([...rows, { id: 'x', name: 'Nowhere' }])
  assert.equal(out.length, 34)
  assert.deepEqual(missingGeometry([{ id: 'x', name: 'Nowhere' }]), ['Nowhere'])
})

check('cells are closed polygons of at least 3 vertices', () => {
  for (const c of districtCells(rows)) {
    assert.ok(c.poly.length >= 3, `${c.name} has ${c.poly.length} vertices`)
  }
})

check('every vertex and headquarters sits inside the Punjab bounds', () => {
  const [[s, w], [n, e]] = PUNJAB_BOUNDS
  for (const c of districtCells(rows)) {
    assert.ok(c.lat >= s && c.lat <= n && c.lon >= w && c.lon <= e, `${c.name} HQ outside bounds`)
    for (const [lat, lng] of c.poly) {
      assert.ok(lat >= s - 0.5 && lat <= n + 0.5, `${c.name} vertex lat ${lat}`)
      assert.ok(lng >= w - 0.5 && lng <= e + 0.5, `${c.name} vertex lng ${lng}`)
    }
  }
})

// The property that makes a click trustworthy: a Voronoi cell must contain its
// OWN headquarters and no other district's. If this fails, clicking a district
// opens a different one's data.
check("each cell contains its own HQ and no other district's", () => {
  const cells = districtCells(rows)
  const inside = (pt, poly) => {
    let c = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j]
      if ((a[0] > pt[0]) !== (b[0] > pt[0]) &&
          pt[1] < ((b[1] - a[1]) * (pt[0] - a[0])) / (b[0] - a[0]) + a[1]) c = !c
    }
    return c
  }
  for (const c of cells) {
    assert.ok(inside([c.lat, c.lon], c.poly), `${c.name} does not contain its own HQ`)
    for (const other of cells) {
      if (other.name === c.name) continue
      assert.ok(!inside([other.lat, other.lon], c.poly),
        `${c.name}'s cell contains ${other.name}'s headquarters`)
    }
  }
})

console.log('\nformatters')

check('a missing value is a dash, never a zero', () => {
  assert.equal(dash(null), '—')
  assert.equal(dash(undefined), '—')
  assert.equal(dash(NaN), '—')
  // 0 is a real measurement and must survive.
  assert.equal(dash(0), '0.00')
})

check('yield decimals follow the crop scale', () => {
  assert.equal(yieldDec(62), 1)      // sugarcane
  assert.equal(yieldDec(3.05), 2)    // wheat
  assert.equal(f1(3.0519, 2), '3.05')
})

check('mean reports whether it managed to weight', () => {
  const rs = [{ v: 1, w: 1 }, { v: 3, w: 3 }]
  assert.deepEqual(mean(rs, 'v', 'w'), { value: 2.5, weighted: true, n: 2 })
  // A missing weight on any row falls back to unweighted and SAYS so, rather
  // than silently weighting part of the set.
  const partial = [{ v: 1, w: 1 }, { v: 3 }]
  const m = mean(partial, 'v', 'w')
  assert.equal(m.weighted, false)
  assert.equal(m.value, 2)
})

check('mean of nothing is null, not zero', () => {
  assert.deepEqual(mean([], 'v'), { value: null, weighted: false, n: 0 })
  assert.equal(mean([{ v: null }], 'v').value, null)
})

check('norm and clamp stay in range', () => {
  assert.equal(norm(5, 0, 10), 0.5)
  assert.equal(norm(-5, 0, 10), 0)
  assert.equal(norm(50, 0, 10), 1)
  assert.equal(clamp(11, 0, 10), 10)
})

check('ramp returns a valid hex at both ends and between', () => {
  const stops = ['#000000', '#ffffff']
  assert.equal(ramp(stops, 0), '#000000')
  assert.equal(ramp(stops, 1), '#ffffff')
  assert.match(ramp(stops, 0.5), /^#[0-9a-f]{6}$/)
  // Out-of-range input must clamp rather than produce garbage.
  assert.equal(ramp(stops, -3), '#000000')
  assert.equal(ramp(stops, 9), '#ffffff')
})

console.log('\ncsv export')

check('a reason containing commas and quotes stays in one column', () => {
  const reason = 'Yield 23.4% below Multan\'s own 6-season mean for wheat '
    + '(2.10 against 2.74 t/ha), AND soil water retention ranks in the driest 62%.'
  const csv = toCsv([{ district: 'Multan', reason }])
  const [, row] = csv.split('\r\n')
  // Exactly one unquoted comma separates the two fields; the rest are inside quotes.
  assert.ok(row.startsWith('Multan,"'), 'reason was not quoted: ' + row.slice(0, 40))
  assert.equal(row.split('"').length - 1, 2, 'unexpected quote count')
})

check('an embedded double quote is doubled', () => {
  const csv = toCsv([{ a: 'he said "yes"' }])
  assert.equal(csv.split('\r\n')[1], '"he said ""yes"""')
})

check('a leading = is neutralised so a cell cannot execute', () => {
  const csv = toCsv([{ a: '=1+1' }, { a: '-5' }, { a: '+x' }, { a: '@y' }])
  const rows2 = csv.split('\r\n').slice(1)
  for (const r of rows2) assert.ok(r.startsWith('"\t') || r.startsWith('\t'), 'not escaped: ' + r)
})

check('null and undefined export as empty, not as the word null', () => {
  assert.equal(toCsv([{ a: null, b: undefined, c: 0 }]).split('\r\n')[1], ',,0')
})

check('an empty set exports nothing rather than a bare header', () => {
  assert.equal(toCsv([]), '')
})


console.log('\none theme preference, reachable from every entry point')
/* The dark token sets already existed in gov.css; what did not exist was any
 * way to reach them outside the government portal's Settings screen. These
 * checks pin the three things that make it one preference rather than four:
 * the same storage key, applied before first paint, with a visible control. */
{
  const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
  const theme = read('src/lib/theme.js')
  const KEY = theme.match(/THEME_KEY = '([^']+)'/)?.[1]
  check(`the shared module names one key (${KEY})`, () => assert.ok(KEY))
  check('and migrates the government portal\'s old key', () =>
    assert.match(theme, /gov\.theme/))

  // Before first paint, or a dark-theme viewer gets a white flash on every load.
  for (const entry of ['src/main.jsx', 'src/gov/main.jsx', 'src/research/main.jsx']) {
    check(`${entry} applies the saved theme at startup`, () =>
      assert.match(read(entry), /applyTheme\(\)/))
  }
  // No entry point may keep its own key: two stores means two preferences.
  for (const f of ['src/gov/main.jsx', 'src/gov/pages/SettingsPage.jsx']) {
    check(`${f} no longer reads a portal-local theme key`, () =>
      assert.ok(!/localStorage\.getItem\('gov\.theme'\)/.test(read(f))))
  }

  // A control on every surface -- that is the whole point of the change.
  check('the government portal renders the toggle', () =>
    assert.match(read('src/gov/GovApp.jsx'), /<ThemeToggle \/>/))
  check('the researcher portal renders the toggle', () =>
    assert.match(read('src/research/ResearchApp.jsx'), /<ThemeToggle \/>/))
  check('the farmer app renders its own toggle', () =>
    assert.match(read('src/components/TopBar.jsx'), /useTheme\(\)/))
  check('the landing page stores under the same key', () =>
    assert.ok(read('index.html').includes(`'${KEY}'`)))

  // The farmer app had no dark theme at all; it has one now, and it works by
  // redefining the @theme vars rather than by a sweep of class names.
  const css = read('src/index.css')
  check('the farmer stylesheet defines a dark token set', () =>
    assert.match(css, /:root\[data-theme="dark"\]/))
  check('and a system variant behind prefers-color-scheme', () =>
    assert.match(css, /prefers-color-scheme: dark/))
  check('--color-card exists so surfaces are not literal white', () =>
    assert.match(css, /--color-card:/))
  // bg-white cannot be themed. Two deliberate survivors: a switch knob and the
  // "cloud-masked" legend dot, which mean the colour, not the surface.
  const whites = ['src/components', 'src/pages', 'src/App.jsx'].flatMap((d) => {
    const base = new URL('../' + d, import.meta.url)
    const files = d.endsWith('.jsx') ? [base]
      : readdirSync(base).map((f) => new URL('../' + d + '/' + f, import.meta.url))
    return files.filter((f) => f.pathname.endsWith('.jsx'))
      .flatMap((f) => (readFileSync(f, 'utf8').match(/\bbg-white\b/g) ?? []).map(() => f.pathname))
  })
  check(`only the 2 colour-literal uses of bg-white remain (${whites.length})`, () =>
    assert.equal(whites.length, 2))

  // The OPEN select list is painted by the browser from the select's own
  // background, and every select here is transparent so the pill shows through.
  // Without an explicit rule on <option> that list stayed grey-on-near-black.
  for (const [f, token] of [['src/gov/gov.css', '--card'], ['src/index.css', '--color-card']]) {
    check(`${f} themes the native option list`, () =>
      assert.match(read(f), new RegExp(`option[\\s\\S]{0,40}background-color: ?var\\(${token}\\)`)))
  }
}


console.log('\npicking a field location without typing coordinates')
/* The old form asked for two numbers. Every value in range is a valid
 * coordinate, so a digit typed wrong by one place moves the field ~11 km with
 * nothing on screen to show it. These pin the helpers that make the map and GPS
 * paths trustworthy. */
{
  const DISTRICTS = JSON.parse(
    readFileSync(new URL('../src/FarmForm.jsx', import.meta.url), 'utf8')
      .match(/export const DISTRICTS = (\{[\s\S]*?\n\})/)[1]
      .replace(/'/g, '"').replace(/(\w[\w ]*):/g, '"$1":').replace(/""/g, '"')
      .replace(/,(\s*\})/g, '$1')
  )
  check(`all 34 districts parsed from FarmForm (${Object.keys(DISTRICTS).length})`, () =>
    assert.equal(Object.keys(DISTRICTS).length, 34))

  // Every seeded centroid must sit inside the box the picker warns about, or
  // the form would warn "outside Punjab" about its own default pin.
  for (const [name, c] of Object.entries(DISTRICTS)) {
    check(`${name}'s centroid is inside the Punjab box`, () =>
      assert.ok(inPunjab(+c.lat, +c.lng)))
  }

  // A centroid must resolve to its own district, or the "change it to X" hint
  // would fire on a pin the farmer placed correctly from the dropdown.
  for (const [name, c] of Object.entries(DISTRICTS)) {
    check(`${name}'s centroid is nearest ${name}`, () =>
      assert.equal(nearestDistrict(DISTRICTS, +c.lat, +c.lng).name, name))
  }

  // Distance sanity. NOT the ~37 km between the two TOWNS: these are GAUL
  // polygon centroids, as FarmForm's own comment says, and centroid-to-centroid
  // is 45.5 km. Checked by hand against the components -- 0.157 deg of latitude
  // is 17.4 km, 0.443 deg of longitude at 31.5N is 42.0 km, and those give 45.5.
  const km = metresBetween(
    { lat: +DISTRICTS.Lahore.lat, lng: +DISTRICTS.Lahore.lng },
    { lat: +DISTRICTS.Sheikhupura.lat, lng: +DISTRICTS.Sheikhupura.lng }) / 1000
  check(`Lahore to Sheikhupura centroids is about 45 km (${km.toFixed(1)})`, () =>
    assert.ok(km > 43 && km < 48))

  check('a pin in Karachi is outside the Punjab box', () =>
    assert.equal(inPunjab(24.86, 67.01), false))
  check('a pin in Lahore is inside it', () =>
    assert.equal(inPunjab(31.47, 74.36), true))
  check('a blank coordinate is not treated as a location', () =>
    assert.equal(inPunjab(NaN, NaN), false))

  // 5 decimals is ~1 m; a phone reports 7+, which is noise on a field boundary.
  check('a GPS reading is rounded to about a metre', () =>
    assert.equal(round5(31.46631234567), 31.46631))
  check('and rounding does not drift the value', () =>
    assert.ok(Math.abs(round5(74.35841111) - 74.35841) < 1e-9))

  // The three ways in must all still be present: GPS, map, typed.
  const picker = readFileSync(new URL('../src/components/LocationPicker.jsx', import.meta.url), 'utf8')
  check('the GPS path is offered', () => assert.match(picker, /navigator\.geolocation/))
  check('the map accepts a tap to place the pin', () => assert.match(picker, /useMapEvents/))
  check('the pin is draggable', () => assert.match(picker, /draggable/))
  check('typed coordinates remain reachable (the only keyboard path)', () =>
    assert.match(picker, /<details/))
  check('a refused permission is explained separately from a failed fix', () =>
    assert.ok(/PERMISSION_DENIED/.test(picker) && /POSITION_UNAVAILABLE/.test(picker)))
  check('the sampled-area circle is drawn from the same radiusOf as the maps', () =>
    assert.match(picker, /radius=\{radiusOf\(area\)\}/))

  check('the map offers a street layer as well as satellite', () =>
    assert.ok(/LayersControl/.test(picker) && /openstreetmap\.org/.test(picker)))
  check('a place can be searched by name', () =>
    assert.match(picker, /nominatim\.openstreetmap\.org/))
  // Nominatim's policy is ~1 request/second. Searching per keystroke would
  // breach it from a single user typing a village name.
  check('place search fires on submit, not on every keystroke', () =>
    assert.ok(!/onChange=\{[^}]*search\(\)/.test(picker)))

  // THE BROKEN MARKER, which showed on every map in the app. Icon.Default
  // PREPENDS its auto-detected imagePath to whatever iconUrl you set, and Vite
  // inlines these three PNGs as data: URIs because they are under 4 KB -- so
  // mergeOptions alone produced "/path/" + "data:image/png;base64,..." and 404d
  // every time. Deleting the override is what makes the option be used verbatim.
  const farmMap = readFileSync(new URL('../src/components/FarmMap.jsx', import.meta.url), 'utf8')
  check('the Leaflet default-icon path override is removed', () =>
    assert.match(farmMap, /delete L\.Icon\.Default\.prototype\._getIconUrl/))
  check('and it is removed BEFORE the urls are merged in', () =>
    assert.ok(farmMap.indexOf('delete L.Icon.Default.prototype._getIconUrl')
              < farmMap.indexOf('L.Icon.Default.mergeOptions')))

  const form = readFileSync(new URL('../src/FarmForm.jsx', import.meta.url), 'utf8')
  check('the form no longer ships bare latitude/longitude inputs', () =>
    assert.ok(!/Latitude\s*\n\s*<input/.test(form)))
}

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed ? 1 : 0)

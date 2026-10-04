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

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed ? 1 : 0)

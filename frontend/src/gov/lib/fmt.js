/** Formatters and colour ramps, ported from the design's helper block.
 *
 * The design's `hash` and `rng` are NOT ported. They existed to generate the
 * synthetic district values the mock-up ran on; this portal reads real rows, so
 * a seeded random number generator has nothing left to do. Deleting them also
 * removes the only way a fabricated number could reach a screen.
 */

export const f1 = (v, d = 1) => Number(v).toFixed(d)

export const fmt = (v) => Math.round(Number(v)).toLocaleString('en-US')

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

export const norm = (v, a, b) => clamp((v - a) / (b - a), 0, 1)

export const title = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

/** A dash, not a zero.
 *
 * Every number on these screens is either measured or modelled. When one is
 * absent the cell has to say so: printing 0 for "no row" is the difference
 * between "this district harvested nothing" and "we did not load this
 * district", and a policymaker cannot tell those apart from a 0.
 */
export const dash = (v, fn = (x) => f1(x, 2)) =>
  v == null || Number.isNaN(Number(v)) ? '—' : fn(Number(v))

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))

/** Linear interpolation along a list of hex stops. */
export function ramp(stops, t) {
  t = clamp(t, 0, 1) * (stops.length - 1)
  const i = Math.min(Math.floor(t), stops.length - 2)
  const k = t - i
  const a = hex(stops[i])
  const b = hex(stops[i + 1])
  return '#' + a.map((x, j) => Math.round(x + (b[j] - x) * k).toString(16).padStart(2, '0')).join('')
}

export const RAMPS = {
  ndvi: ['#b88a4a', '#e3cf7a', '#a8cf6a', '#4fa35f', '#136b43'],
  water: ['#e8d9a8', '#a9d3d6', '#4aa0c4', '#1d5f96'],
  risk: ['#4fa35f', '#e5c14a', '#d9822b', '#b4342b'],
  harvest: ['#d9a441', '#e5d77f', '#9ccb7e', '#2f7a55'],
  prio: ['#cfe3d3', '#e5d77f', '#e09a3c', '#a8322a'],
  yield: ['#d9a441', '#e5d77f', '#8fc77a', '#1f6d49'],
}

/** Per-crop colour, matching the design's palette for its five crops and
 *  extending it for the six the design did not show but the data covers. */
export const CROP_COLOR = {
  wheat: '#c9a227', rice: '#4aa0c4', maize: '#e0a23a', cotton: '#b08bc4',
  sugarcane: '#6fae52', barley: '#a8975c', bajra: '#cf8b5a', jowar: '#9a7b4f',
  potato: '#8a9b5c', onion: '#b5657f', tomato: '#c0514a',
}
export const cropColor = (name) => CROP_COLOR[name] || '#9aa79f'

/** Alert type -> colour, from the design's TC map, keyed on the DB's enum
 *  values rather than the design's display strings. */
export const ALERT_COLOR = {
  flood: '#2f6f9a', drought: '#d9822b', water_stress: '#d4b02a', anomaly: '#8a4fa0',
}
export const ALERT_LABEL = {
  flood: 'Flood', drought: 'Drought', water_stress: 'Water stress', anomaly: 'Anomaly',
}

/** Area-weighted mean, with a plain mean as the fallback.
 *
 * The design always had an `area` to weight by because it invented one.
 * gov_crop_area_estimates is empty, so there is usually no weight available --
 * and an unweighted provincial mean must be LABELLED as unweighted rather than
 * passed off as production-weighted. Returns the weighting actually used so the
 * caller can say which it got.
 */
export function mean(rows, key, weightKey) {
  // The null check comes BEFORE Number(), and that order is the whole point:
  // Number(null) is 0 and Number.isFinite(0) is true, so filtering after the
  // conversion counts every missing measurement as a zero. In a provincial mean
  // that reads as a district reporting a total crop failure.
  const num = (v) => (v == null || v === '' ? NaN : Number(v))
  const vals = rows.map((r) => [num(r[key]), weightKey ? num(r[weightKey]) : null])
                   .filter(([v]) => Number.isFinite(v))
  if (!vals.length) return { value: null, weighted: false, n: 0 }
  const usable = vals.filter(([, w]) => Number.isFinite(w) && w > 0)
  if (weightKey && usable.length === vals.length) {
    const wsum = usable.reduce((a, [, w]) => a + w, 0)
    return { value: usable.reduce((a, [v, w]) => a + v * w, 0) / wsum, weighted: true, n: vals.length }
  }
  return { value: vals.reduce((a, [v]) => a + v, 0) / vals.length, weighted: false, n: vals.length }
}

/** Yield decimals: sugarcane runs at ~60 t/ha, onions at ~0.8, so a fixed 2 dp
 *  prints either noise or nothing useful. Ported from the design's `c.y>10?1:2`. */
export const yieldDec = (v) => (Math.abs(Number(v)) >= 10 ? 1 : 2)

export const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

export const fmtAgo = (iso) => {
  if (!iso) return '—'
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const m = Math.round(days / 30)
  return m === 1 ? 'a month ago' : `${m} months ago`
}

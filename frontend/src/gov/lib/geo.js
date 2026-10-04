/** Approximate district cells for the maps.
 *
 * WHY THIS FILE EXISTS AT ALL: gov_districts.geom is NULL for every row. Real
 * boundaries need a shapefile import (FAO GAUL level 2) that is not part of
 * this task, and the schema migration carries the TODO. Until that lands, the
 * portal needs *something* a district can be clicked on.
 *
 * So each district gets a Voronoi cell around its headquarters, clipped to an
 * approximate Punjab outline -- ported unchanged from the design, which solved
 * the same problem the same way. The cells share borders and tile the province,
 * so the map reads correctly and a click resolves to one district. They are NOT
 * administrative boundaries, they are nearest-town catchments, and every map
 * legend in this portal says "approximate" for exactly that reason.
 *
 * When real polygons arrive: fetch gov_districts.geom, and where it is non-null
 * use it in place of `cell`. Nothing else has to change -- districtCells()
 * already returns {name, lat, lon, poly}, which is the shape GovMap consumes.
 */

/** Punjab bounds, for the initial map fit. [[S,W],[N,E]] in Leaflet order. */
export const PUNJAB_BOUNDS = [[27.6, 69.4], [34.1, 75.5]]

/** Approximate provincial outline, [lon, lat]. */
const OUTLINE = [
  [71.8, 33.45], [72.0, 33.9], [72.6, 34.0], [73.2, 33.95], [73.55, 33.6], [73.7, 33.2],
  [74.1, 32.9], [74.65, 32.78], [75.0, 32.35], [74.85, 32.0], [74.6, 31.6], [74.5, 31.1],
  [74.1, 30.9], [73.8, 30.4], [73.4, 29.95], [72.9, 29.55], [72.2, 29.0], [71.4, 28.4],
  [70.6, 28.0], [70.0, 27.75], [69.6, 27.9], [69.55, 28.6], [69.8, 29.3], [69.9, 30.0],
  [70.2, 30.6], [70.35, 31.1], [70.7, 31.55], [71.1, 32.0], [71.35, 32.5], [71.4, 33.0],
]

export const OUTLINE_LATLNG = OUTLINE.map((p) => [p[1], p[0]])

/** District headquarters: [name, lon, lat, labelOnMap].
 *
 * ALL 36 are kept as tessellation seeds even though gov_districts holds 34.
 * Nankana Sahib and Chiniot have no data upstream (they were carved out of
 * Sheikhupura and Jhang after the reporting series began), but dropping their
 * seeds would hand their territory to the parent district's cell and draw
 * Sheikhupura twice its real size. They seed the geometry and are then filtered
 * out of the result by districtCells(), which only returns districts the
 * database actually has.
 */
const SITES = [
  ['Rawalpindi', 73.05, 33.6, 1], ['Attock', 72.35, 33.77], ['Chakwal', 72.85, 32.93],
  ['Jhelum', 73.73, 32.93], ['Gujrat', 74.07, 32.57], ['Mandi Bahauddin', 73.5, 32.58],
  ['Sialkot', 74.53, 32.5], ['Narowal', 74.75, 32.15], ['Gujranwala', 74.18, 32.16, 1],
  ['Hafizabad', 73.69, 32.07], ['Sheikhupura', 73.98, 31.71], ['Nankana Sahib', 73.7, 31.45],
  ['Lahore', 74.34, 31.52, 1], ['Kasur', 74.3, 31.05], ['Okara', 73.45, 30.81],
  ['Pakpattan', 73.4, 30.35], ['Sahiwal', 73.1, 30.66, 1], ['Faisalabad', 73.07, 31.42, 1],
  ['Toba Tek Singh', 72.48, 30.97], ['Jhang', 72.3, 31.27], ['Chiniot', 72.98, 31.72],
  ['Sargodha', 72.67, 32.08, 1], ['Khushab', 72.35, 32.3], ['Mianwali', 71.55, 32.58],
  ['Bhakkar', 71.07, 31.63], ['Layyah', 70.95, 30.96], ['Muzaffargarh', 71.2, 30.07],
  ['Dera Ghazi Khan', 70.63, 30.05, 1], ['Rajanpur', 70.33, 29.1], ['Multan', 71.47, 30.2, 1],
  ['Lodhran', 71.63, 29.54], ['Khanewal', 71.93, 30.3], ['Vehari', 72.35, 30.04],
  ['Bahawalnagar', 73.25, 29.99], ['Bahawalpur', 71.67, 29.4, 1],
  ['Rahim Yar Khan', 70.3, 28.42, 1],
]

/** The five main rivers, for orientation on the map. [name, [[lon,lat],...]]. */
export const RIVERS = [
  ['Indus', [[71.55, 32.95], [71.55, 32.3], [71.3, 31.6], [71.0, 31.0], [70.8, 30.5],
             [70.7, 29.8], [70.4, 29.0], [70.0, 28.3], [69.7, 27.8]]],
  ['Jhelum', [[73.72, 32.95], [73.2, 32.55], [72.7, 32.1], [72.3, 31.55], [72.15, 31.15]]],
  ['Chenab', [[74.45, 32.7], [74.0, 32.4], [73.7, 32.3], [73.0, 31.8], [72.15, 31.15],
              [71.5, 30.4], [71.0, 29.35]]],
  ['Ravi', [[75.0, 32.3], [74.5, 31.8], [74.3, 31.6], [73.4, 31.0], [72.4, 30.5], [71.8, 30.4]]],
  ['Sutlej', [[74.5, 31.1], [73.9, 30.2], [73.0, 29.7], [72.2, 29.4], [71.0, 29.3]]],
]

// Longitude is compressed by cos(latitude); without this the Voronoi bisectors
// are computed in degree space and the cells lean. 31 deg N is mid-Punjab.
const KX = Math.cos((31 * Math.PI) / 180)

/** Clip a convex polygon to the half-plane nearer to `a` than to `b`. */
function clipHalfPlane(poly, a, b) {
  const nx = b[0] - a[0]
  const ny = b[1] - a[1]
  const c = (b[0] * b[0] + b[1] * b[1] - a[0] * a[0] - a[1] * a[1]) / 2
  const f = (p) => p[0] * nx + p[1] * ny - c
  const out = []
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    const fp = f(p)
    const fq = f(q)
    if (fp <= 0) out.push(p)
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq)
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])])
    }
  }
  return out
}

// Computed once at module load: the tessellation depends on nothing but the
// constants above, so recomputing it per render would be 36 x 35 clips for an
// identical answer.
const scaled = SITES.map((s) => [s[1] * KX, s[2]])
const outlineScaled = OUTLINE.map((p) => [p[0] * KX, p[1]])

const CELLS = SITES.map((s, i) => {
  let poly = outlineScaled
  for (let j = 0; j < SITES.length; j++) {
    if (j !== i) poly = clipHalfPlane(poly, scaled[i], scaled[j])
  }
  return {
    name: s[0],
    lon: s[1],
    lat: s[2],
    label: Boolean(s[3]),
    // Back to [lat, lng] for Leaflet, undoing the longitude scaling.
    poly: poly.map((p) => [p[1], p[0] / KX]),
  }
})

const BY_NAME = new Map(CELLS.map((c) => [c.name, c]))

/**
 * Cells for the districts given, in the order given.
 *
 * `rows` are gov_districts rows (or anything carrying `name`). A district with
 * no cell is dropped rather than guessed at -- a map is the one place where
 * inventing a location is indefensible, because the reader will believe it.
 */
export function districtCells(rows) {
  return rows
    .map((r) => {
      const cell = BY_NAME.get(r.name)
      return cell ? { ...r, ...cell } : null
    })
    .filter(Boolean)
}

/** Districts in gov_districts that this file has no geometry for. Surfaced on
 *  the map so a missing district is visible rather than silently absent. */
export const missingGeometry = (rows) =>
  rows.filter((r) => !BY_NAME.has(r.name)).map((r) => r.name)

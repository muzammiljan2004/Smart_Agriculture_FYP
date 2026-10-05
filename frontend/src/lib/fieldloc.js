/* Coordinate helpers for picking a field location.
 *
 * Plain .js and free of React so they can be asserted from node, which is where
 * the rest of this project's geometry is checked (src/gov/lib/geo.js).
 */

/** Metres between two coordinates.
 *
 * Equirectangular, not haversine. It is accurate well inside a degree and is
 * only ever used here to rank district centres a few tens of km apart, where
 * the two agree to centimetres. Haversine would be the same code with a worse
 * constant-factor and no gain at this scale.
 */
export function metresBetween(a, b) {
  const R = 6371000, rad = Math.PI / 180
  const x = (b.lng - a.lng) * rad * Math.cos((a.lat + b.lat) * rad / 2)
  const y = (b.lat - a.lat) * rad
  return Math.sqrt(x * x + y * y) * R
}

/** The district whose CENTROID is nearest the pin, as {name, d} in metres.
 *
 * A centroid is not a boundary, so near a district edge the nearest centroid can
 * belong to the neighbour. That is why the caller offers this as a question and
 * never applies it: it exists to catch a pin dropped in the wrong half of the
 * province, not to adjudicate which side of a line a field sits on.
 */
export function nearestDistrict(districts, lat, lng) {
  let best = null
  for (const [name, c] of Object.entries(districts)) {
    const d = metresBetween({ lat, lng }, { lat: +c.lat, lng: +c.lng })
    if (!best || d < best.d) best = { name, d }
  }
  return best
}

/** Punjab's rough bounding box. Only used to tell someone their pin is nowhere
 *  near the 34 districts this project has soil and imagery for. */
export const PUNJAB_BBOX = { minLat: 27.5, maxLat: 34.2, minLng: 69.0, maxLng: 75.5 }

export const inPunjab = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng)
  && lat >= PUNJAB_BBOX.minLat && lat <= PUNJAB_BBOX.maxLat
  && lng >= PUNJAB_BBOX.minLng && lng <= PUNJAB_BBOX.maxLng

/** ~1 m. A phone reports 7+ decimals, which is noise on a field boundary and
 *  makes the manual inputs unreadable. */
export const round5 = (n) => Math.round(n * 1e5) / 1e5

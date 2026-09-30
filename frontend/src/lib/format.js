/** Shared display constants and formatters.
 *
 * All moved verbatim out of the old single-page Dashboard so that the pages
 * which inherited its sections render numbers identically to before.
 */

/** t/ha ceiling the model is clipped to, so bars share a scale across farms. */
export const MAX_YIELD = 6

export const INDEX_META = {
  ndvi: ['NDVI', 'Vegetation greenness'],
  evi: ['EVI', 'Enhanced vegetation'],
  ndwi: ['NDWI', 'Canopy water'],
  savi: ['SAVI', 'Soil-adjusted'],
  nbr: ['NBR', 'Burn / residue'],
}

/** FAO land-evaluation classes. Colour carries the same ordering as the class
 *  itself, so a panel is scannable without reading a single label. */
export const SUIT_STYLE = {
  S1: ['bg-leaf-100 text-leaf-800 ring-leaf-200', 'Highly suitable'],
  S2: ['bg-wheat-300/30 text-wheat-500 ring-wheat-300/60', 'Moderately suitable'],
  S3: ['bg-orange-100 text-orange-700 ring-orange-200', 'Marginally suitable'],
  N: ['bg-red-50 text-red-700 ring-red-200', 'Not suitable'],
  excluded: ['bg-leaf-50 text-muted ring-leaf-100', 'Ruled out'],
}

export const fmtDate = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })

export const fmtShort = (iso) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

export const title = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

/** The marker both imagery 404s carry and no other error does. A farmer cannot
 *  act on "GET /farms/<uuid>/timeseries?refresh=true", so when that is the
 *  reason the UI shows the button that does it instead of the sentence. */
export const needsImagery = (err) =>
  Boolean(err && err.includes('timeseries?refresh=true'))

/** The second imagery 404: imagery exists, but all of it falls outside this
 *  crop's observation window, so it is bare ground rather than the crop. */
export const isOutOfSeason = (err) => needsImagery(err) && err.includes('outside')

/** The 422 raised when a field never greens up across a whole season. */
export const isNoCrop = (err) =>
  Boolean(err && err.includes('No active crop vegetation'))

/** The 422 raised when every in-window observation predates sowing. */
export const isWrongSeason = (err) =>
  Boolean(err && err.includes('No imagery of this crop cycle'))

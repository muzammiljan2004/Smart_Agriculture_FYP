import { RAMPS } from './fmt'

/* The five Sentinel-2 indices the pipeline computes, with how to draw each one.
 *
 * MOVED HERE FROM SatellitePage so the dashboard map can offer the same five.
 * The dashboard was hardcoded to NDVI -- the other four were computed, stored
 * and shown on the satellite screen, but the map a user lands on first could
 * only ever draw one of them. Two copies of this table would drift the moment
 * one screen's scale was tuned, and a district shaded "good" on one screen and
 * "poor" on another with the same number is worse than no second screen.
 *
 * `lo`/`hi` are the ends of the colour ramp, not the physical range: NDVI runs
 * -1 to 1, but Punjab cropland sits in 0.2-0.8 and stretching the ramp over the
 * full range would render every district the same mid-green.
 */
export const INDICES = {
  ndvi: {
    label: 'NDVI', ramp: RAMPS.ndvi, lo: 0.2, hi: 0.8,
    formula: '(NIR − Red) / (NIR + Red)',
    about: 'Canopy greenness and vigour. The index the yield model leans on most.',
  },
  evi: {
    label: 'EVI', ramp: RAMPS.ndvi, lo: 0.1, hi: 0.6,
    formula: '2.5 × (NIR − Red) / (NIR + 6·Red − 7.5·Blue + 1)',
    about: 'Enhanced vegetation index. Saturates less than NDVI over a dense canopy.',
  },
  ndwi: {
    // Reversed: on the water ramp the wet end is the dark end, and for a
    // standing crop "more canopy water" is the good direction, so the ramp has
    // to run the same way round as the other four or the map reads inverted.
    label: 'NDWI', ramp: [...RAMPS.water].reverse(), lo: -0.2, hi: 0.3,
    formula: '(Green − NIR) / (Green + NIR)',
    about: 'Canopy and surface water. Falling NDWI on a standing crop points at irrigation gaps.',
  },
  savi: {
    label: 'SAVI', ramp: RAMPS.ndvi, lo: 0.1, hi: 0.6,
    formula: '1.5 × (NIR − Red) / (NIR + Red + 0.5)',
    about: 'Soil-adjusted. More reliable than NDVI early in a season, over partial cover.',
  },
  nbr: {
    label: 'NBR', ramp: RAMPS.ndvi, lo: 0.0, hi: 0.5,
    formula: '(NIR − SWIR2) / (NIR + SWIR2)',
    about: 'Normalised burn ratio. Residue burning and burn scars.',
  },
}

/** Tab pairs for a selector, in pipeline order. */
export const INDEX_TABS = Object.entries(INDICES).map(([k, v]) => [k, v.label])
